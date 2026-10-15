export interface Repository {
  id: string;
  name: string;
  repoUrl: string;
  description: string | null;
  packageType: string | null;
  packageName: string | null;
  crateName: string | null;
  githubRepo: string | null;
  dockerImage: string | null;
  contractsCount: number;
  ownerAddress: string | null;
  metadataUri: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastAttestedAt: string | null;
}

export type RepositoryInput = Omit<Repository, "id" | "active" | "createdAt" | "updatedAt" | "lastAttestedAt">;

export interface MetricPoint {
  repoId: string;
  source: string;
  metricKey: string;
  value: number;
  points: number;
  raw: unknown;
  recordedAt: string;
}

export interface SourceBreakdown {
  source: string;
  metricKey: string;
  value: number;
  points: number;
  weight: number;
  contribution: number;
}

export interface ScoreSnapshot {
  repoId: string;
  score: number;
  breakdown: SourceBreakdown[];
  computedAt: string;
}

export interface Badge {
  key: string;
  title: string;
  value: number;
}

export interface Milestone {
  key: string;
  title: string;
  value: number;
}

export type AttestationStatus = "confirmed" | "pending" | "failed";

export interface Attestation {
  uid: string;
  repoId: string | null;
  kind: "badge" | "milestone" | "score" | "drip-list";
  title: string;
  value: number | null;
  status: AttestationStatus;
  txHash: string | null;
  blockNumber: number | null;
  metadataUri: string | null;
  note: string | null;
  createdAt: string;
}

export interface DripSplit {
  repoId: string;
  percent: number;
}

export interface DripList {
  id: string;
  name: string;
  description: string | null;
  ownerAddress: string | null;
  splits: DripSplit[];
  status: "saved" | "attested";
  attestationUid: string | null;
  createdAt: string;
}

export interface Scorecard {
  repository: Repository;
  score: number;
  breakdown: SourceBreakdown[];
  metrics: MetricPoint[];
  badges: Badge[];
  milestones: Milestone[];
  snapshotHash: string;
  computedAt: string;
  oracle: {
    signer: string;
    timestamp: number;
    signature: string;
  };
  attestations: Attestation[];
  onChain: {
    registered: boolean;
    registryAddress: string | null;
    chainId: number;
  };
}
