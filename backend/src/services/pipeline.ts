import { encodePacked, keccak256, type Hex } from "viem";

import { config } from "../config";
import {
  deleteFailedAttestations,
  getRepository,
  hasAttestation,
  insertAttestation,
  insertMetric,
  insertScore,
  latestConfirmedByTitle,
  latestMetricsBySource,
  listActiveRepositories,
  listAttestations,
  setRepositoryAttested,
  updateAttestation,
} from "../db";
import * as attester from "../services/attester";
import { deriveBadgesAndMilestones } from "../services/badges";
import { computeScore, pointsForSource } from "../services/scoreEngine";
import type { Attestation, Badge, MetricPoint, Milestone, Repository } from "../types";
import { fetchContractImports, fetchCratesDownloads, fetchDockerPulls, fetchGithubRepo, fetchNpmDownloads } from "../pipeline/sources";

export interface RefreshResult {
  repoId: string;
  score: number;
  metrics: MetricPoint[];
  badges: Badge[];
  milestones: Milestone[];
  attestations: AttestationResult[];
  sourceErrors: string[];
  onChainErrors: string[];
}

interface AttestationResult {
  kind: "badge" | "milestone" | "score";
  title: string;
  value: number;
  status: "confirmed" | "pending" | "failed";
  uid?: string;
  txHash?: string;
  error?: string;
}

function metadataUri(repoId: string, kind: string, title: string): string {
  return `${config.publicBaseUrl}/api/metadata/repositories/${encodeURIComponent(repoId)}/${kind}/${encodeURIComponent(
    title,
  )}.json`;
}

function placeholderUid(repoId: string, kind: string, title: string, value: number): Hex {
  return keccak256(
    encodePacked(["string", "string", "string", "uint256"], [repoId, kind, title, BigInt(value)]),
  );
}

async function attestOne(
  repo: Repository,
  kind: "badge" | "milestone" | "score",
  title: string,
  value: number,
): Promise<AttestationResult> {
  const metadataUrl = metadataUri(repo.id, kind, title);
  const placeholder = placeholderUid(repo.id, kind, title, value);

  try {
    const result =
      kind === "milestone"
        ? await attester.attestMilestone(repo, title, value, metadataUrl)
        : kind === "badge"
          ? await attester.attestBadge(repo, title, value, metadataUrl)
          : await attester.attestScore(repo, value, metadataUrl);

    insertAttestation({
      uid: result.uid,
      repoId: repo.id,
      kind,
      title,
      value,
      status: "confirmed",
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      metadataUri: metadataUrl,
      note: null,
    });
    setRepositoryAttested(repo.id);
    return { kind, title, value, status: "confirmed", uid: result.uid, txHash: result.txHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    insertAttestation({
      uid: placeholder,
      repoId: repo.id,
      kind,
      title,
      value,
      status: "failed",
      txHash: null,
      blockNumber: null,
      metadataUri: metadataUrl,
      note: message,
    });
    return { kind, title, value, status: "failed", error: message };
  }
}

async function attestChanges(repo: Repository, score: number, badges: Badge[], milestones: Milestone[]): Promise<AttestationResult[]> {
  const results: AttestationResult[] = [];

  const lastScore = latestConfirmedByTitle(repo.id, "score", "impact-score");
  if (score > 0 && (!lastScore || lastScore.value !== score)) {
    results.push(await attestOne(repo, "score", "impact-score", score));
  }

  for (const badge of badges) {
    if (hasAttestation({ repoId: repo.id, kind: "badge", title: badge.key })) continue;
    results.push(await attestOne(repo, "badge", badge.key, badge.value));
  }

  for (const milestone of milestones) {
    if (hasAttestation({ repoId: repo.id, kind: "milestone", title: milestone.key })) continue;
    results.push(await attestOne(repo, "milestone", milestone.key, milestone.value));
  }

  return results;
}

/** Refreshes metrics for a single repository, computes the impact score and attests changes. */
export async function refreshRepo(repoId: string): Promise<RefreshResult> {
  const repo = getRepository(repoId);
  if (!repo) throw new Error(`Repository not found: ${repoId}`);

  const jobs: { key: string; run: () => Promise<import("../pipeline/sources").FetchedMetric | import("../pipeline/sources").FetchedMetric[]> }[] = [];
  if (repo.packageName) jobs.push({ key: "npm", run: () => fetchNpmDownloads(repo.packageName!) });
  if (repo.crateName) jobs.push({ key: "crates", run: () => fetchCratesDownloads(repo.crateName!) });
  if (repo.dockerImage) jobs.push({ key: "docker", run: () => fetchDockerPulls(repo.dockerImage!) });
  if (repo.githubRepo) jobs.push({ key: "github", run: () => fetchGithubRepo(repo.githubRepo!) });
  if (repo.contractsCount > 0) jobs.push({ key: "contracts", run: () => Promise.resolve(fetchContractImports(repo.contractsCount)) });

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));

  const metrics: MetricPoint[] = [];
  const sourceErrors: string[] = [];
  settled.forEach((result, index) => {
    const job = jobs[index]!;
    if (result.status === "fulfilled") {
      const fetched = Array.isArray(result.value) ? result.value : [result.value];
      for (const m of fetched) {
        metrics.push({
          repoId: repo.id,
          source: m.source,
          metricKey: m.metricKey,
          value: m.value,
          points: Math.round(pointsForSource(m.source, m.value) * 100) / 100,
          raw: m.raw,
          recordedAt: new Date().toISOString(),
        });
      }
    } else {
      sourceErrors.push(`${job.key}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });

  const { score, breakdown } = computeScore(metrics);
  for (const m of metrics) insertMetric(m);
  insertScore({ repoId: repo.id, score, breakdown });

  const { badges, milestones } = deriveBadgesAndMilestones(score, metrics, repo.contractsCount);

  const onChainErrors: string[] = [];
  try {
    await attester.ensureRepositoryRegistered(repo);
  } catch (error) {
    onChainErrors.push(error instanceof Error ? error.message : String(error));
  }

  const attestations = await attestChanges(repo, score, badges, milestones);

  return { repoId: repo.id, score, metrics, badges, milestones, attestations, sourceErrors, onChainErrors };
}

export async function refreshAll(): Promise<RefreshResult[]> {
  const repos = listActiveRepositories();
  const results: RefreshResult[] = [];
  for (const repo of repos) {
    try {
      results.push(await refreshRepo(repo.id));
    } catch (error) {
      console.error(`[pipeline] failed to refresh ${repo.id}:`, error);
    }
  }
  return results;
}

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Starts the periodic ingestion loop. */
export function startPipeline(): void {
  if (interval) return;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      deleteFailedAttestations(); // cleanup rows that will be re-created with fresh attempts
      await refreshAll();
    } catch (error) {
      console.error("[pipeline] error:", error);
    } finally {
      running = false;
    }
  };
  if (config.ingestOnStart) {
    void run();
  }
  interval = setInterval(run, config.ingestIntervalMs);
}

export function stopPipeline(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export async function latestAttestationsFor(repoId: string): Promise<Attestation[]> {
  return listAttestations(repoId);
}
