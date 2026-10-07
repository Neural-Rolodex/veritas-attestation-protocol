import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePacked, keccak256, zeroAddress } from "viem";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface SchemaDef {
  uid: string;
  schema: string;
}

export interface ChainConfig {
  network: string;
  chainId: number;
  schemaRegistry: string;
  eas: string;
  impactRegistry: string;
  oracle: string;
  schemas: {
    impactBadge: SchemaDef;
    milestone: SchemaDef;
    dripList: SchemaDef;
  };
}

export interface Config {
  port: number;
  publicBaseUrl: string;
  corsOrigin: string;
  databasePath: string;
  rpcUrl: string;
  chainId: number;
  registryAddress?: string;
  easAddress?: string;
  deploymentsFile: string;
  explorerUrl?: string;
  oraclePrivateKey: string;
  ingestOnStart: boolean;
  ingestIntervalMs: number;
  githubToken?: string;
  adminApiKey: string;
  chain: ChainConfig;
}

export const SCHEMA_STRINGS = {
  impactBadge: "string repoUrl,string badge,uint256 score,string metadataURI",
  milestone: "string repoUrl,string milestone,uint256 value,string metadataURI",
  dripList: "string metadataURI",
} as const;

/** Matches EAS SchemaRegistry._getUID: keccak256(abi.encodePacked(schema, resolver, revocable)). */
export function schemaUid(schema: string, resolver: `0x${string}` = zeroAddress, revocable = true): string {
  const packed = encodePacked(["string", "address", "bool"], [schema, resolver, revocable]);
  return keccak256(packed);
}

function env(name: string): string | undefined {
  return process.env[name] && process.env[name]!.length > 0 ? process.env[name] : undefined;
}

function readDeployments(file: string): ChainConfig | undefined {
  const abs = resolve(file);
  if (!existsSync(abs)) return undefined;
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as ChainConfig;
  } catch {
    return undefined;
  }
}

function schemas(): ChainConfig["schemas"] {
  return {
    impactBadge: { schema: SCHEMA_STRINGS.impactBadge, uid: schemaUid(SCHEMA_STRINGS.impactBadge) },
    milestone: { schema: SCHEMA_STRINGS.milestone, uid: schemaUid(SCHEMA_STRINGS.milestone) },
    dripList: { schema: SCHEMA_STRINGS.dripList, uid: schemaUid(SCHEMA_STRINGS.dripList) },
  };
}

export function loadConfig(): Config {
  const deploymentsFile = resolve(env("DEPLOYMENTS_FILE") ?? "../contracts/deployments/local.json");
  const chain = readDeployments(deploymentsFile);

  const chainId = Number(env("CHAIN_ID") ?? chain?.chainId ?? 31337);
  const oraclePrivateKey =
    env("ORACLE_PRIVATE_KEY") ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

  return {
    port: Number(env("PORT") ?? 8080),
    publicBaseUrl: env("PUBLIC_BASE_URL") ?? "http://localhost:8080",
    corsOrigin: env("CORS_ORIGIN") ?? "*",
    databasePath: resolve(env("DATABASE_PATH") ?? "./data/impact.db"),
    rpcUrl: env("RPC_URL") ?? "http://127.0.0.1:8545",
    chainId,
    registryAddress: env("REGISTRY_ADDRESS"),
    easAddress: env("EAS_ADDRESS"),
    deploymentsFile,
    explorerUrl: env("EXPLORER_URL"),
    oraclePrivateKey,
    ingestOnStart: (env("INGEST_ON_START") ?? "true") === "true",
    ingestIntervalMs: Number(env("INGEST_INTERVAL_MS") ?? 6 * 60 * 60 * 1000),
    githubToken: env("GITHUB_TOKEN"),
    adminApiKey: env("ADMIN_API_KEY") ?? "dev-admin-key",
    chain: chain ?? {
      network: "custom",
      chainId,
      schemaRegistry: "",
      eas: "",
      impactRegistry: "",
      oracle: "",
      schemas: schemas(),
    },
  };
}

export const config = loadConfig();
