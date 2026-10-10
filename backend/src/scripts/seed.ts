import { createRepository, getRepository, getRepositoryByUrl, initDb } from "../db";
import { refreshAll } from "../services/pipeline";

/**
 * Seeds the database with example repositories (real projects, real public
 * metrics via the ingestion pipeline). Run with: npm run seed
 */
const SEED_REPOSITORIES = [
  {
    id: "ethers",
    name: "ethers.js",
    repoUrl: "https://github.com/ethers-io/ethers.js",
    description: "A complete, tiny and simple Ethereum library for JavaScript.",
    packageType: "npm",
    packageName: "ethers",
    crateName: null,
    githubRepo: "ethers-io/ethers.js",
    dockerImage: null,
    contractsCount: 850,
    ownerAddress: null,
    metadataUri: null,
  },
  {
    id: "viem",
    name: "viem",
    repoUrl: "https://github.com/wevm/viem",
    description: "TypeScript interface for Ethereum.",
    packageType: "npm",
    packageName: "viem",
    crateName: null,
    githubRepo: "wevm/viem",
    dockerImage: null,
    contractsCount: 120,
    ownerAddress: null,
    metadataUri: null,
  },
  {
    id: "oz-contracts",
    name: "OpenZeppelin Contracts",
    repoUrl: "https://github.com/OpenZeppelin/openzeppelin-contracts",
    description: "A library for secure smart contract development.",
    packageType: "npm",
    packageName: "@openzeppelin/contracts",
    crateName: null,
    githubRepo: "OpenZeppelin/openzeppelin-contracts",
    dockerImage: null,
    contractsCount: 12000,
    ownerAddress: null,
    metadataUri: null,
  },
  {
    id: "serde",
    name: "serde",
    repoUrl: "https://github.com/serde-rs/serde",
    description: "Serialization framework for Rust.",
    packageType: "crates",
    packageName: null,
    crateName: "serde",
    githubRepo: "serde-rs/serde",
    dockerImage: null,
    contractsCount: 0,
    ownerAddress: null,
    metadataUri: null,
  },
  {
    id: "tokio",
    name: "tokio",
    repoUrl: "https://github.com/tokio-rs/tokio",
    description: "A runtime for writing reliable asynchronous applications with Rust.",
    packageType: "crates",
    packageName: null,
    crateName: "tokio",
    githubRepo: "tokio-rs/tokio",
    dockerImage: null,
    contractsCount: 0,
    ownerAddress: null,
    metadataUri: null,
  },
  {
    id: "nats",
    name: "NATS Server",
    repoUrl: "https://github.com/nats-io/nats-server",
    description: "High-performance, cloud native messaging system.",
    packageType: "docker",
    packageName: null,
    crateName: null,
    githubRepo: "nats-io/nats-server",
    dockerImage: "library/nats",
    contractsCount: 0,
    ownerAddress: null,
    metadataUri: null,
  },
  {
    id: "nginx",
    name: "NGINX",
    repoUrl: "https://github.com/nginx/nginx",
    description: "An HTTP and reverse proxy server.",
    packageType: "docker",
    packageName: null,
    crateName: null,
    githubRepo: "nginx/nginx",
    dockerImage: "library/nginx",
    contractsCount: 0,
    ownerAddress: null,
    metadataUri: null,
  },
  {
    id: "farcaster-core",
    name: "Farcaster Core",
    repoUrl: "https://github.com/farcasterxyz/protocol",
    description: "A sufficiently decentralized social network. Library imported by on-chain Farcaster contracts.",
    packageType: "source",
    packageName: null,
    crateName: null,
    githubRepo: "farcasterxyz/protocol",
    dockerImage: null,
    contractsCount: 40,
    ownerAddress: null,
    metadataUri: null,
  },
];

async function main() {
  initDb();
  const created: string[] = [];
  for (const seed of SEED_REPOSITORIES) {
    if (getRepository(seed.id)) {
      console.log(`  exists  ${seed.id}`);
      continue;
    }
    if (getRepositoryByUrl(seed.repoUrl)) {
      console.log(`  url exists ${seed.id}`);
      continue;
    }
    createRepository(seed);
    created.push(seed.id);
    console.log(`  created ${seed.id}`);
  }
  console.log(`\n${created.length} repositories seeded.`);
  console.log("Refreshing metrics (fetches live public data + mints attestations)...\n");

  const results = await refreshAll();
  for (const r of results) {
    const attested = r.attestations.map((a) => `${a.title}:${a.status}`).join(", ");
    console.log(
      `  ${r.repoId}: score ${r.score} | attestations: ${attested || "none"}${
        r.sourceErrors.length ? ` | source errors: ${r.sourceErrors.length}` : ""
      }${r.onChainErrors.length ? ` | chain errors: ${r.onChainErrors.length}` : ""}`,
    );
  }
  console.log("\nSeed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
