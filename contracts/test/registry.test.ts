import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const IMPACT_BADGE_SCHEMA = "string repoUrl,string badge,uint256 score,string metadataURI";
const MILESTONE_SCHEMA = "string repoUrl,string milestone,uint256 value,string metadataURI";
const DRIP_LIST_SCHEMA = "string metadataURI";
const ZERO = "0x0000000000000000000000000000000000000000";
const REPO_URL = "https://github.com/ethers-io/ethers.js";
const METADATA = "https://example.com/metadata/badge.json";

function schemaUid(schema: string): string {
  const packed = ethers.solidityPacked(["string", "address", "bool"], [schema, ZERO, true]);
  return ethers.keccak256(packed);
}

async function deployFixture() {
  const [owner, oracle, stranger] = await ethers.getSigners();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const srArtifact = require("@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const easArtifact = require("@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json");

  const schemaRegistry = await new ethers.ContractFactory(srArtifact.abi, srArtifact.bytecode, owner).deploy();
  await schemaRegistry.waitForDeployment();

  const eas = await new ethers.ContractFactory(easArtifact.abi, easArtifact.bytecode, owner).deploy(
    await schemaRegistry.getAddress(),
  );
  await eas.waitForDeployment();

  const Registry = await ethers.getContractFactory("ImpactAttestationRegistry");
  const registry = await Registry.deploy(
    await eas.getAddress(),
    await schemaRegistry.getAddress(),
    IMPACT_BADGE_SCHEMA,
    MILESTONE_SCHEMA,
    DRIP_LIST_SCHEMA,
    true,
  );
  await registry.waitForDeployment();

  await registry.setOracle(oracle.address);

  return { owner, oracle, stranger, schemaRegistry, eas, registry };
}

describe("ImpactAttestationRegistry", () => {
  describe("deployment", () => {
    it("registers the three EAS schemas and exposes their UIDs", async () => {
      const { registry, schemaRegistry } = await loadFixture(deployFixture);

      expect(await registry.impactBadgeSchema()).to.equal(schemaUid(IMPACT_BADGE_SCHEMA));
      expect(await registry.milestoneSchema()).to.equal(schemaUid(MILESTONE_SCHEMA));
      expect(await registry.dripListSchema()).to.equal(schemaUid(DRIP_LIST_SCHEMA));

      const record = await schemaRegistry.getSchema(await registry.impactBadgeSchema());
      expect(record.schema).to.equal(IMPACT_BADGE_SCHEMA);
      expect(record.resolver).to.equal(ZERO);
      expect(record.revocable).to.equal(true);
    });

    it("rejects zero addresses", async () => {
      const { owner } = await loadFixture(deployFixture);
      const Registry = await ethers.getContractFactory("ImpactAttestationRegistry");
      await expect(
        Registry.deploy(ZERO, ZERO, IMPACT_BADGE_SCHEMA, MILESTONE_SCHEMA, DRIP_LIST_SCHEMA, true),
      ).to.be.revertedWithCustomError(Registry, "ZeroAddress");
    });
  });

  describe("access control", () => {
    it("lets only the owner set the oracle", async () => {
      const { registry, stranger, owner } = await loadFixture(deployFixture);
      await expect(registry.connect(stranger).setOracle(stranger.address))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
      await registry.connect(owner).setOracle(stranger.address);
      expect(await registry.oracle()).to.equal(stranger.address);
    });

    it("rejects repository registration from non-oracles", async () => {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(
        registry.connect(stranger).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA),
      ).to.be.revertedWithCustomError(registry, "NotOracle");
    });

    it("rejects badge attestation from non-oracles", async () => {
      const { registry, oracle, stranger } = await loadFixture(deployFixture);
      await registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA);
      await expect(
        registry.connect(stranger).attestImpactBadge(REPO_URL, "verified-impact", 9000, METADATA),
      ).to.be.revertedWithCustomError(registry, "NotOracle");
    });
  });

  describe("registerRepository", () => {
    it("registers a repository and emits an event", async () => {
      const { registry, oracle } = await loadFixture(deployFixture);
      const repoId = ethers.solidityPackedKeccak256(["string"], [REPO_URL]);

      await expect(registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA))
        .to.emit(registry, "RepositoryRegistered")
        .withArgs(repoId, REPO_URL, "ethers.js");

      const repo = await registry.repository(repoId);
      expect(repo.id).to.equal(repoId);
      expect(repo.repoUrl).to.equal(REPO_URL);
      expect(repo.name).to.equal("ethers.js");
      expect(repo.packageType).to.equal("npm");
      expect(repo.active).to.equal(true);
      expect(repo.registeredAt).to.be.gt(0);

      expect(await registry.repositoryCount()).to.equal(1);
      expect(await registry.repositoryIds()).to.deep.equal([repoId]);
    });

    it("rejects duplicate registrations", async () => {
      const { registry, oracle } = await loadFixture(deployFixture);
      await registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA);
      await expect(
        registry.connect(oracle).registerRepository(REPO_URL, "ethers.js again", "npm", ZERO, METADATA),
      ).to.be.revertedWithCustomError(registry, "RepositoryAlreadyRegistered");
    });

    it("rejects empty urls and names", async () => {
      const { registry, oracle } = await loadFixture(deployFixture);
      await expect(registry.connect(oracle).registerRepository("", "x", "npm", ZERO, METADATA))
        .to.be.revertedWithCustomError(registry, "EmptyString");
      await expect(registry.connect(oracle).registerRepository(REPO_URL, "", "npm", ZERO, METADATA))
        .to.be.revertedWithCustomError(registry, "EmptyString");
    });
  });

  describe("attestImpactBadge", () => {
    it("mints an EAS attestation with the badge schema and recorded data", async () => {
      const { registry, oracle, eas } = await loadFixture(deployFixture);
      await registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA);
      const repoId = ethers.solidityPackedKeccak256(["string"], [REPO_URL]);

      const tx = await registry.connect(oracle).attestImpactBadge(REPO_URL, "verified-impact", 9000, METADATA);
      const receipt = await tx.wait();
      const [uid] = await registry.queryFilter(registry.filters.ImpactAttestationCreated(repoId), receipt.blockNumber, receipt.blockNumber).then((e) => e.map((x) => x.args.uid));

      const attestation = await eas.getAttestation(uid);
      expect(attestation.schema).to.equal(await registry.impactBadgeSchema());
      expect(attestation.attester).to.equal(await registry.getAddress());
      expect(attestation.recipient).to.equal(oracle.address);
      expect(attestation.revocationTime).to.equal(0);
      expect(attestation.revocable).to.equal(true);

      const [repoUrl, badge, score, metadata] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["string", "string", "uint256", "string"],
        attestation.data,
      );
      expect(repoUrl).to.equal(REPO_URL);
      expect(badge).to.equal("verified-impact");
      expect(score).to.equal(9000n);
      expect(metadata).to.equal(METADATA);
    });

    it("records the UID against the repository", async () => {
      const { registry, oracle } = await loadFixture(deployFixture);
      await registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA);
      const repoId = ethers.solidityPackedKeccak256(["string"], [REPO_URL]);

      const tx = await registry.connect(oracle).attestImpactBadge(REPO_URL, "verified-impact", 9000, METADATA);
      const receipt = await tx.wait();
      const events = await registry.queryFilter(registry.filters.ImpactAttestationCreated(repoId), receipt.blockNumber, receipt.blockNumber);

      const uids = await registry.repositoryAttestations(repoId);
      expect(uids).to.deep.equal([events[0].args.uid]);
      expect(await registry.verifyAttestation(events[0].args.uid)).to.equal(true);
    });

    it("reverts for unregistered repositories", async () => {
      const { registry, oracle } = await loadFixture(deployFixture);
      await expect(registry.connect(oracle).attestImpactBadge(REPO_URL, "verified-impact", 9000, METADATA))
        .to.be.revertedWithCustomError(registry, "RepositoryNotFound");
    });
  });

  describe("attestMilestone", () => {
    it("mints a milestone attestation with the milestone schema", async () => {
      const { registry, oracle, eas } = await loadFixture(deployFixture);
      await registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA);
      const repoId = ethers.solidityPackedKeccak256(["string"], [REPO_URL]);

      const tx = await registry.connect(oracle).attestMilestone(REPO_URL, "1m-monthly-downloads", 1200000, METADATA);
      const receipt = await tx.wait();
      const events = await registry.queryFilter(registry.filters.ImpactAttestationCreated(repoId), receipt.blockNumber, receipt.blockNumber);
      const uid = events[0].args.uid;

      const attestation = await eas.getAttestation(uid);
      expect(attestation.schema).to.equal(await registry.milestoneSchema());
      const [repoUrl, milestone, value, metadata] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["string", "string", "uint256", "string"],
        attestation.data,
      );
      expect(repoUrl).to.equal(REPO_URL);
      expect(milestone).to.equal("1m-monthly-downloads");
      expect(value).to.equal(1200000n);
      expect(metadata).to.equal(METADATA);
    });
  });

  describe("attestDripList", () => {
    it("mints a drip list attestation signed by the oracle", async () => {
      const { registry, oracle, eas } = await loadFixture(deployFixture);
      const uri = "https://example.com/driplists/list.json";

      const tx = await registry.connect(oracle).attestDripList(uri);
      const receipt = await tx.wait();
      const events = await registry.queryFilter(registry.filters.DripListAttested(), receipt.blockNumber, receipt.blockNumber);

      const attestation = await eas.getAttestation(events[0].args.uid);
      expect(attestation.schema).to.equal(await registry.dripListSchema());
      expect(attestation.attester).to.equal(await registry.getAddress());
      expect(attestation.recipient).to.equal(oracle.address);
      const [data] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], attestation.data);
      expect(data).to.equal(uri);
    });
  });

  describe("verify & revoke", () => {
    it("returns false for unknown attestations", async () => {
      const { registry } = await loadFixture(deployFixture);
      const fakeUid = ethers.keccak256(ethers.toUtf8Bytes("nope"));
      expect(await registry.verifyAttestation(fakeUid)).to.equal(false);
    });

    it("revokes an attestation and reflects it in verifyAttestation", async () => {
      const { registry, oracle } = await loadFixture(deployFixture);
      await registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA);
      const repoId = ethers.solidityPackedKeccak256(["string"], [REPO_URL]);

      const tx = await registry.connect(oracle).attestImpactBadge(REPO_URL, "verified-impact", 9000, METADATA);
      const receipt = await tx.wait();
      const events = await registry.queryFilter(registry.filters.ImpactAttestationCreated(repoId), receipt.blockNumber, receipt.blockNumber);
      const uid = events[0].args.uid;

      expect(await registry.verifyAttestation(uid)).to.equal(true);
      await registry.connect(oracle).revokeImpactAttestation(repoId, uid);
      expect(await registry.verifyAttestation(uid)).to.equal(false);

      const record = await registry.attestationRecord(uid);
      expect(record.kind).to.equal("badge");
    });

    it("only the oracle can revoke, and only matching repo attestations", async () => {
      const { registry, oracle, stranger } = await loadFixture(deployFixture);
      await registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA);
      const repoId = ethers.solidityPackedKeccak256(["string"], [REPO_URL]);
      const otherId = ethers.solidityPackedKeccak256(["string"], ["https://github.com/other/repo"]);

      const tx = await registry.connect(oracle).attestImpactBadge(REPO_URL, "verified-impact", 9000, METADATA);
      const receipt = await tx.wait();
      const events = await registry.queryFilter(registry.filters.ImpactAttestationCreated(repoId), receipt.blockNumber, receipt.blockNumber);
      const uid = events[0].args.uid;

      await expect(registry.connect(stranger).revokeImpactAttestation(repoId, uid))
        .to.be.revertedWithCustomError(registry, "NotOracle");
      await expect(registry.connect(oracle).revokeImpactAttestation(otherId, uid))
        .to.be.revertedWithCustomError(registry, "AttestationNotFound");
    });
  });

  describe("repository management", () => {
    it("updates repository metadata", async () => {
      const { registry, oracle } = await loadFixture(deployFixture);
      await registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA);
      const repoId = ethers.solidityPackedKeccak256(["string"], [REPO_URL]);

      await registry.connect(oracle).updateRepository(repoId, "ethers", "npm", oracle.address, "ipfs://new");
      const repo = await registry.repository(repoId);
      expect(repo.name).to.equal("ethers");
      expect(repo.owner).to.equal(oracle.address);
      expect(repo.metadataURI).to.equal("ipfs://new");
    });

    it("deactivates a repository", async () => {
      const { registry, oracle } = await loadFixture(deployFixture);
      await registry.connect(oracle).registerRepository(REPO_URL, "ethers.js", "npm", ZERO, METADATA);
      const repoId = ethers.solidityPackedKeccak256(["string"], [REPO_URL]);

      await registry.connect(oracle).setRepositoryActive(repoId, false);
      expect((await registry.repository(repoId)).active).to.equal(false);
    });
  });
});
