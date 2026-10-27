import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { ethers, network } from "hardhat";

const IMPACT_BADGE_SCHEMA = "string repoUrl,string badge,uint256 score,string metadataURI";
const MILESTONE_SCHEMA = "string repoUrl,string milestone,uint256 value,string metadataURI";
const DRIP_LIST_SCHEMA = "string metadataURI";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function schemaUid(schema: string, resolver: string, revocable: boolean): string {
  const encoded = ethers.solidityPacked(["string", "address", "bool"], [schema, resolver, revocable]);
  return ethers.keccak256(encoded);
}

async function deployFromArtifact(
  artifactPath: string,
  args: unknown[],
  signer: any,
): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const artifact = require(artifactPath);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  const [deployer, oracle] = await ethers.getSigners();
  console.log(`Deploying on "${network.name}" (chainId ${network.config.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Oracle:   ${oracle.address}`);

  // 1. EAS infrastructure (real contracts, precompiled in the eas-contracts package)
  console.log("\n[1/4] Deploying EAS SchemaRegistry...");
  const schemaRegistry = await deployFromArtifact(
    "@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json",
    [],
    deployer,
  );
  console.log(`  SchemaRegistry: ${await schemaRegistry.getAddress()}`);

  console.log("[2/4] Deploying EAS...");
  const eas = await deployFromArtifact(
    "@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json",
    [await schemaRegistry.getAddress()],
    deployer,
  );
  console.log(`  EAS: ${await eas.getAddress()}`);

  // 2. Veritas Attestation Protocol
  console.log("[3/4] Deploying ImpactAttestationRegistry...");
  const ImpactRegistry = await ethers.getContractFactory("ImpactAttestationRegistry");
  const registry = await ImpactRegistry.deploy(
    await eas.getAddress(),
    await schemaRegistry.getAddress(),
    IMPACT_BADGE_SCHEMA,
    MILESTONE_SCHEMA,
    DRIP_LIST_SCHEMA,
    true,
  );
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`  ImpactAttestationRegistry: ${registryAddress}`);

  // 3. Grant the oracle role (the backend signs + mints attestations with this key)
  console.log("[4/4] Setting oracle...");
  const tx = await registry.setOracle(oracle.address);
  await tx.wait();
  console.log(`  Oracle: ${oracle.address}`);

  // Compute the schema UIDs deterministically (matches SchemaRegistry._getUID)
  const schemas = {
    impactBadge: { uid: schemaUid(IMPACT_BADGE_SCHEMA, ZERO_ADDRESS, true), schema: IMPACT_BADGE_SCHEMA },
    milestone: { uid: schemaUid(MILESTONE_SCHEMA, ZERO_ADDRESS, true), schema: MILESTONE_SCHEMA },
    dripList: { uid: schemaUid(DRIP_LIST_SCHEMA, ZERO_ADDRESS, true), schema: DRIP_LIST_SCHEMA },
  };

  const result = {
    network: network.name,
    chainId: network.config.chainId ?? 31337,
    schemaRegistry: await schemaRegistry.getAddress(),
    eas: await eas.getAddress(),
    impactRegistry: registryAddress,
    oracle: oracle.address,
    schemas,
    deployedAt: new Date().toISOString(),
  };

  const outDir = join(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${network.name}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nWrote deployment config to ${outFile}`);

  // Also keep a stable "local.json" alias so local tooling doesn't need to guess
  if (network.name === "localhost" || network.name === "hardhat") {
    writeFileSync(join(outDir, "local.json"), JSON.stringify(result, null, 2) + "\n");
  }

  console.log("\nDeployment complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
