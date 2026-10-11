import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
  type Chain,
  type Hex,
} from "viem";

import { config } from "../config";
import { easAbi, registryAbi } from "../lib/abi";
import type { Repository } from "../types";
import { oracleAccount } from "./signer";

export class ChainNotConfiguredError extends Error {
  constructor() {
    super(
      "Chain not configured: set REGISTRY_ADDRESS/EAS_ADDRESS or DEPLOYMENTS_FILE and start the local node",
    );
  }
}

function chainFor(): Chain {
  return {
    id: config.chainId,
    name: "Impact Registry",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  };
}

export function registryAddress(): string {
  const addr = config.registryAddress ?? config.chain.impactRegistry;
  if (!addr) throw new ChainNotConfiguredError();
  return addr;
}

export function easAddress(): string {
  const addr = config.easAddress ?? config.chain.eas;
  if (!addr) throw new ChainNotConfiguredError();
  return addr;
}

export function publicClient() {
  return createPublicClient({ chain: chainFor(), transport: http(config.rpcUrl) });
}

export function walletClient() {
  return createWalletClient({
    account: oracleAccount(),
    chain: chainFor(),
    transport: http(config.rpcUrl),
  });
}

export function repoIdOf(repoUrl: string): Hex {
  return keccak256(stringToHex(repoUrl));
}

export interface AttestationResult {
  uid: string;
  txHash: string;
  blockNumber: number;
}

interface AttestCall {
  repoUrl: string;
  title: string;
  value: number;
  metadataUri: string;
  kind: "badge" | "milestone" | "score";
}

async function writeAttest(call: AttestCall): Promise<AttestationResult> {
  const client = publicClient();
  const wallet = walletClient();
  const address = registryAddress() as `0x${string}`;

  const functionName =
    call.kind === "milestone" ? "attestMilestone" : "attestImpactBadge";

  const args: [string, string, bigint, string] =
    call.kind === "milestone"
      ? [call.repoUrl, call.title, BigInt(call.value), call.metadataUri]
      : [call.repoUrl, call.title, BigInt(call.value), call.metadataUri];

  const txHash = await wallet.writeContract({
    address,
    abi: registryAbi,
    functionName,
    args,
  });

  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  const events = parseEventLogs({ logs: receipt.logs, abi: registryAbi, eventName: "ImpactAttestationCreated" });
  const uid = events[0]?.args.uid;
  if (!uid) throw new Error(`No ImpactAttestationCreated event in tx ${txHash}`);
  return { uid, txHash, blockNumber: Number(receipt.blockNumber) };
}

/** Reads the on-chain repository record for a repo (idempotent). */
export async function readRepository(
  repo: Pick<Repository, "repoUrl">,
): Promise<{ active: boolean; owner: string; registeredAt: number } | null> {
  const client = publicClient();
  const address = registryAddress() as `0x${string}`;
  const existing = await client.readContract({
    address,
    abi: registryAbi,
    functionName: "repository",
    args: [repoIdOf(repo.repoUrl)],
  });
  const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
  if (!existing || existing.id === ZERO) return null;
  return {
    active: existing.active,
    owner: existing.owner,
    registeredAt: Number(existing.registeredAt),
  };
}

/** Ensures the repository is registered on-chain (idempotent). */
export async function ensureRepositoryRegistered(repo: Repository): Promise<void> {
  const client = publicClient();
  const wallet = walletClient();
  const address = registryAddress() as `0x${string}`;

  const existing = await readRepository(repo);
  if (existing?.active) return;

  const txHash = await wallet.writeContract({
    address,
    abi: registryAbi,
    functionName: "registerRepository",
    args: [repo.repoUrl, repo.name, repo.packageType ?? "source", (repo.ownerAddress ?? oracleAccount().address) as Hex, repo.metadataUri ?? ""],
  });
  await client.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
}

export async function attestBadge(repo: Repository, badge: string, value: number, metadataUri: string): Promise<AttestationResult> {
  return writeAttest({ repoUrl: repo.repoUrl, title: badge, value, metadataUri, kind: "badge" });
}

export async function attestMilestone(repo: Repository, milestone: string, value: number, metadataUri: string): Promise<AttestationResult> {
  return writeAttest({ repoUrl: repo.repoUrl, title: milestone, value, metadataUri, kind: "milestone" });
}

export async function attestScore(repo: Repository, score: number, metadataUri: string): Promise<AttestationResult> {
  return writeAttest({ repoUrl: repo.repoUrl, title: "impact-score", value: score, metadataUri, kind: "score" });
}

/** Mints a drip list attestation; returns the UID. */
export async function attestDripList(metadataUri: string): Promise<AttestationResult> {
  const client = publicClient();
  const wallet = walletClient();
  const txHash = await wallet.writeContract({
    address: registryAddress() as `0x${string}`,
    abi: registryAbi,
    functionName: "attestDripList",
    args: [metadataUri],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  const events = parseEventLogs({ logs: receipt.logs, abi: registryAbi, eventName: "DripListAttested" });
  const uid = events[0]?.args.uid;
  if (!uid) throw new Error(`No DripListAttested event in tx ${txHash}`);
  return { uid, txHash, blockNumber: Number(receipt.blockNumber) };
}

/** Reads an EAS attestation by UID and resolves its schema string. */
export async function readAttestation(uid: string): Promise<{
  uid: string;
  schema: string;
  schemaString: string;
  attester: string;
  recipient: string;
  time: number;
  revocationTime: number;
  revocable: boolean;
  data: string;
} | null> {
  const client = publicClient();
  const eas = easAddress() as `0x${string}`;
  const attestation = await client.readContract({
    address: eas,
    abi: easAbi,
    functionName: "getAttestation",
    args: [uid as `0x${string}`],
  });
  const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
  if (!attestation || attestation.uid === ZERO) {
    return null;
  }
  const schemaRecord = await client.readContract({
    address: eas,
    abi: easAbi,
    functionName: "getSchema",
    args: [attestation.schema],
  });

  return {
    uid,
    schema: attestation.schema,
    schemaString: Array.isArray(schemaRecord) ? String(schemaRecord[3]) : schemaRecord.schema,
    attester: attestation.attester,
    recipient: attestation.recipient,
    time: Number(attestation.time),
    revocationTime: Number(attestation.revocationTime),
    revocable: attestation.revocable,
    data: attestation.data,
  };
}

/** Verifies an attestation is valid and unrevoked (reads the registry view). */
export async function verifyOnChain(uid: string): Promise<boolean> {
  const client = publicClient();
  return client.readContract({
    address: registryAddress() as `0x${string}`,
    abi: registryAbi,
    functionName: "verifyAttestation",
    args: [uid as `0x${string}`],
  });
}
