import { encodePacked, keccak256 } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRepository, initDb, latestMetricsBySource, latestScore, listAttestations } from "../src/db";

const { refreshRepo } = await import("../src/services/pipeline");

const mocks = vi.hoisted(() => ({
  fetchNpmDownloads: vi.fn(),
  fetchGithubRepo: vi.fn(),
  fetchCratesDownloads: vi.fn(),
  fetchDockerPulls: vi.fn(),
  fetchContractImports: vi.fn(),
  ensureRepositoryRegistered: vi.fn(),
  attestBadge: vi.fn(),
  attestMilestone: vi.fn(),
  attestScore: vi.fn(),
}));

vi.mock("../src/pipeline/sources", () => ({
  fetchNpmDownloads: mocks.fetchNpmDownloads,
  fetchGithubRepo: mocks.fetchGithubRepo,
  fetchCratesDownloads: mocks.fetchCratesDownloads,
  fetchDockerPulls: mocks.fetchDockerPulls,
  fetchContractImports: mocks.fetchContractImports,
}));

vi.mock("../src/services/attester", () => ({
  ensureRepositoryRegistered: mocks.ensureRepositoryRegistered,
  attestBadge: mocks.attestBadge,
  attestMilestone: mocks.attestMilestone,
  attestScore: mocks.attestScore,
}));

function makeRepo(contractsCount = 100) {
  createRepository({
    id: "ethers",
    name: "ethers.js",
    repoUrl: "https://github.com/ethers-io/ethers.js",
    description: null,
    packageType: "npm",
    packageName: "ethers",
    crateName: null,
    githubRepo: "ethers-io/ethers.js",
    dockerImage: null,
    contractsCount,
    ownerAddress: null,
    metadataUri: null,
  });
}

function uid(seed: string): string {
  return keccak256(encodePacked(["string"], [seed]));
}

function okResult(seed: string) {
  return { uid: uid(seed), txHash: `0x${"ab".repeat(32)}`, blockNumber: 42 };
}

beforeEach(() => {
  initDb(":memory:");
  vi.clearAllMocks();
  mocks.fetchNpmDownloads.mockResolvedValue({
    source: "npm",
    metricKey: "downloads_30d",
    value: 1_000_000,
    raw: {},
  });
  mocks.fetchGithubRepo.mockResolvedValue([
    { source: "github", metricKey: "stars", value: 25_000, raw: {} },
  ]);
  mocks.fetchContractImports.mockReturnValue({
    source: "contracts",
    metricKey: "imports",
    value: 100,
    raw: {},
  });
  mocks.ensureRepositoryRegistered.mockResolvedValue(undefined);
  mocks.attestBadge.mockImplementation(async (_r: unknown, badge: string) => okResult(`badge-${badge}`));
  mocks.attestMilestone.mockImplementation(async (_r: unknown, milestone: string) => okResult(`milestone-${milestone}`));
  mocks.attestScore.mockImplementation(async (_r: unknown, score: number) => okResult(`score-${score}`));
});

describe("refreshRepo pipeline", () => {
  it("fetches sources, computes score, derives badges/milestones and attests", async () => {
    makeRepo();
    const result = await refreshRepo("ethers");

    expect(result.score).toBeGreaterThan(70);
    expect(result.badges.map((b) => b.key).sort()).toEqual(
      ["broad-usage", "high-adoption", "on-chain-adopted", "verified-impact"].sort(),
    );
    expect(result.milestones.map((m) => m.key).sort()).toEqual(
      ["contracts-50-imports", "github-10k-stars", "npm-1m-downloads"].sort(),
    );

    // metrics + score persisted
    const metrics = latestMetricsBySource("ethers");
    expect(metrics.map((m) => m.source).sort()).toEqual(["contracts", "github", "npm"].sort());
    expect(latestScore("ethers")!.score).toBe(result.score);

    // attestations created on-chain (mocked) and stored as confirmed
    const attested = listAttestations("ethers");
    expect(attested).toHaveLength(8);
    expect(attested.every((a) => a.status === "confirmed")).toBe(true);
    expect(attested.some((a) => a.kind === "score" && a.title === "impact-score")).toBe(true);
    expect(attested.filter((a) => a.kind === "badge").map((a) => a.title).sort()).toEqual(
      ["broad-usage", "high-adoption", "on-chain-adopted", "verified-impact"].sort(),
    );
    expect(mocks.attestScore).toHaveBeenCalledTimes(1);

    // metadata URI is resolvable
    expect(attested[0]!.metadataUri).toMatch(/\/api\/metadata\/repositories\/ethers\//);
  });

  it("is idempotent: does not re-attest unchanged scores/badges", async () => {
    makeRepo();
    await refreshRepo("ethers");
    mocks.attestBadge.mockClear();
    mocks.attestMilestone.mockClear();
    mocks.attestScore.mockClear();
    await refreshRepo("ethers");
    expect(mocks.attestScore).not.toHaveBeenCalled();
    expect(mocks.attestBadge).not.toHaveBeenCalled();
    expect(mocks.attestMilestone).not.toHaveBeenCalled();
    expect(listAttestations("ethers")).toHaveLength(8);
  });

  it("records failed attestations when the chain is down", async () => {
    makeRepo();
    mocks.attestScore.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8545"));
    mocks.attestBadge.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8545"));
    mocks.attestMilestone.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8545"));

    const result = await refreshRepo("ethers");
    expect(result.attestations.every((a) => a.status === "failed")).toBe(true);
    const stored = listAttestations("ethers");
    expect(stored.every((a) => a.status === "failed")).toBe(true);
    expect(stored[0]!.note).toMatch(/ECONNREFUSED/);
    // failed rows use deterministic placeholder uids and can be retried
    const again = await refreshRepo("ethers");
    expect(again.attestations.every((a) => a.status === "failed")).toBe(true);
  });

  it("tolerates failing data sources", async () => {
    makeRepo();
    mocks.fetchNpmDownloads.mockRejectedValue(new Error("npm registry 500"));
    mocks.fetchGithubRepo.mockRejectedValue(new Error("rate limited"));

    const result = await refreshRepo("ethers");
    expect(result.sourceErrors).toHaveLength(2);
    expect(result.metrics.map((m) => m.source)).toEqual(["contracts"]);
    expect(result.score).toBeGreaterThan(0);
  });

  it("skips attestation when no data is available", async () => {
    makeRepo(0);
    mocks.fetchNpmDownloads.mockRejectedValue(new Error("down"));
    mocks.fetchGithubRepo.mockRejectedValue(new Error("down"));

    const result = await refreshRepo("ethers");
    expect(result.score).toBe(0);
    expect(result.attestations).toEqual([]);
    expect(mocks.attestScore).not.toHaveBeenCalled();
  });
});
