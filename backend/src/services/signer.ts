import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToHex, verifyTypedData, zeroAddress, type TypedDataDomain } from "viem";
import { config } from "../config";

export const SNAPSHOT_TYPES = {
  ImpactSnapshot: [
    { name: "repoId", type: "string" },
    { name: "score", type: "uint256" },
    { name: "snapshotHash", type: "bytes32" },
    { name: "timestamp", type: "uint256" },
  ],
} as const;

export type SnapshotMessage = {
  repoId: string;
  score: number;
  snapshotHash: string;
  timestamp: number;
};

type SnapshotTypedMessage = {
  repoId: string;
  score: bigint;
  snapshotHash: `0x${string}`;
  timestamp: bigint;
};

function encodeMessage(message: SnapshotMessage): SnapshotTypedMessage {
  return {
    repoId: message.repoId,
    score: BigInt(message.score),
    snapshotHash: message.snapshotHash as `0x${string}`,
    timestamp: BigInt(message.timestamp),
  };
}

export function oracleAccount() {
  return privateKeyToAccount(config.oraclePrivateKey as `0x${string}`);
}

export function oracleAddress(): string {
  return oracleAccount().address;
}

export function registryForSigning(): string {
  return (config.registryAddress ?? config.chain.impactRegistry) || zeroAddress;
}

export function snapshotHashOf(canonical: string): string {
  return keccak256(stringToHex(canonical));
}

export function snapshotDomain(): TypedDataDomain {
  return {
    name: "ImpactRegistry",
    version: "1",
    chainId: config.chainId,
    verifyingContract: registryForSigning() as `0x${string}`,
  };
}

export interface SignedSnapshot {
  message: SnapshotMessage;
  signer: string;
  signature: string;
}

/**
 * Signs a metrics snapshot with the oracle EOA using EIP-712. The signature is
 * returned alongside the scorecard so anyone can cryptographically verify that
 * the metrics were produced by the backend oracle.
 */
export async function signSnapshot(message: SnapshotMessage): Promise<SignedSnapshot> {
  const account = oracleAccount();
  const signature = await account.signTypedData({
    domain: snapshotDomain(),
    types: SNAPSHOT_TYPES,
    primaryType: "ImpactSnapshot",
    message: encodeMessage(message),
  });
  return { message, signer: account.address, signature };
}

/** Verifies that a snapshot signature was produced by the oracle. */
export async function verifySnapshot(signed: SignedSnapshot): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: signed.signer as `0x${string}`,
      domain: snapshotDomain(),
      types: SNAPSHOT_TYPES,
      primaryType: "ImpactSnapshot",
      message: encodeMessage(signed.message),
      signature: signed.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}
