import { config } from "../config";

export interface FetchedMetric {
  source: string;
  metricKey: string;
  value: number;
  raw: unknown;
}

const TIMEOUT_MS = 15_000;

async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "veritas-attestation-protocol/0.1", ...headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** npm registry downloads in the last 30 days. */
export async function fetchNpmDownloads(packageName: string): Promise<FetchedMetric> {
  const data = (await fetchJson(
    `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(packageName)}`,
  )) as { downloads?: number; package?: string };
  if (typeof data.downloads !== "number") {
    throw new Error(`npm response missing downloads for ${packageName}`);
  }
  return { source: "npm", metricKey: "downloads_30d", value: data.downloads, raw: { package: data.package ?? packageName } };
}

/** crates.io downloads in the last 90 days (recent_downloads). */
export async function fetchCratesDownloads(crateName: string): Promise<FetchedMetric> {
  const data = (await fetchJson(
    `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`,
  )) as { crate?: { recent_downloads?: number; downloads?: number; name?: string } };
  const value = data.crate?.recent_downloads;
  if (typeof value !== "number") {
    throw new Error(`crates.io response missing recent_downloads for ${crateName}`);
  }
  return { source: "crates", metricKey: "downloads_90d", value, raw: { name: data.crate?.name ?? crateName } };
}

/** Docker Hub total pull count for an image (e.g. "library/nginx"). */
export async function fetchDockerPulls(image: string): Promise<FetchedMetric> {
  const data = (await fetchJson(
    `https://hub.docker.com/v2/repositories/${encodeURIComponent(image)}`,
  )) as { pull_count?: number; name?: string; namespace?: string };
  if (typeof data.pull_count !== "number") {
    throw new Error(`Docker Hub response missing pull_count for ${image}`);
  }
  return {
    source: "docker",
    metricKey: "pulls",
    value: data.pull_count,
    raw: { name: data.name ?? image, namespace: data.namespace },
  };
}

/** GitHub repository stars + forks (e.g. "wevm/viem"). */
export async function fetchGithubRepo(repo: string): Promise<FetchedMetric[]> {
  const headers: Record<string, string> = {};
  if (config.githubToken) {
    headers.authorization = `Bearer ${config.githubToken}`;
  }
  const data = (await fetchJson(`https://api.github.com/repos/${encodeURIComponent(repo)}`, headers)) as {
    stargazers_count?: number;
    forks_count?: number;
    full_name?: string;
  };
  const result: FetchedMetric[] = [];
  if (typeof data.stargazers_count === "number") {
    result.push({ source: "github", metricKey: "stars", value: data.stargazers_count, raw: { full_name: data.full_name } });
  }
  if (typeof data.forks_count === "number") {
    result.push({ source: "github-forks", metricKey: "forks", value: data.forks_count, raw: { full_name: data.full_name } });
  }
  if (result.length === 0) {
    throw new Error(`GitHub response missing stats for ${repo}`);
  }
  return result;
}

/**
 * On-chain adoption: number of known deployed smart contracts that import the
 * library. This count is operator-maintained (curated in the repository row)
 * because discovering contract imports requires a chain indexer / source scan.
 */
export function fetchContractImports(contractsCount: number): FetchedMetric {
  return { source: "contracts", metricKey: "imports", value: contractsCount, raw: { note: "operator-curated" } };
}
