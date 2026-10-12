import type { Badge, MetricPoint, Milestone } from "../types";
import { SOURCE_SCALES } from "./scoreEngine";

interface Threshold {
  value: number;
  key: string;
  title: string;
}

const DOWNLOAD_THRESHOLDS: Threshold[] = [
  { value: 100_000, key: "100k-downloads", title: "100,000+ downloads" },
  { value: 1_000_000, key: "1m-downloads", title: "1M+ downloads" },
  { value: 10_000_000, key: "10m-downloads", title: "10M+ downloads" },
];

const STAR_THRESHOLDS: Threshold[] = [
  { value: 1_000, key: "1k-stars", title: "1,000+ GitHub stars" },
  { value: 10_000, key: "10k-stars", title: "10,000+ GitHub stars" },
  { value: 100_000, key: "100k-stars", title: "100,000+ GitHub stars" },
];

const PULL_THRESHOLDS: Threshold[] = [
  { value: 10_000_000, key: "10m-pulls", title: "10M+ Docker pulls" },
  { value: 100_000_000, key: "100m-pulls", title: "100M+ Docker pulls" },
];

const IMPORT_THRESHOLDS: Threshold[] = [
  { value: 10, key: "10-imports", title: "10+ contracts import it" },
  { value: 50, key: "50-imports", title: "50+ contracts import it" },
  { value: 200, key: "200-imports", title: "200+ contracts import it" },
];

export interface DerivedBadges {
  badges: Badge[];
  milestones: Milestone[];
}

function biggestCrossed(value: number, thresholds: Threshold[]): Threshold | undefined {
  return [...thresholds].reverse().find((t) => value >= t.value);
}

export function deriveBadgesAndMilestones(
  score: number,
  metrics: MetricPoint[],
  contractsCount: number,
): DerivedBadges {
  const badges: Badge[] = [];
  const milestones: Milestone[] = [];

  const bySource = new Map<string, number>();
  for (const m of metrics) bySource.set(m.source, m.value);

  if (score >= 70) {
    badges.push({ key: "verified-impact", title: "Verified Impact", value: score });
  }
  const bestPoints = Math.max(0, ...metrics.map((m) => m.points));
  if (bestPoints >= 85) {
    badges.push({ key: "high-adoption", title: "High Adoption", value: Math.round(bestPoints) });
  }
  const strongSources = metrics.filter((m) => m.points >= 40).length;
  if (strongSources >= 3) {
    badges.push({ key: "broad-usage", title: "Broad Usage", value: strongSources });
  }
  if ((bySource.get("contracts") ?? 0) >= 10 || contractsCount >= 10) {
    badges.push({ key: "on-chain-adopted", title: "On-Chain Adopted", value: contractsCount });
  }

  const npmDownloads = bySource.get("npm") ?? 0;
  const milestone = biggestCrossed(npmDownloads, DOWNLOAD_THRESHOLDS);
  if (milestone) {
    milestones.push({ key: `npm-${milestone.key}`, title: `npm: ${milestone.title}`, value: npmDownloads });
  }

  const cratesDownloads = bySource.get("crates") ?? 0;
  const cratesMilestone = biggestCrossed(cratesDownloads, DOWNLOAD_THRESHOLDS);
  if (cratesMilestone) {
    milestones.push({
      key: `crates-${cratesMilestone.key}`,
      title: `crates.io: ${cratesMilestone.title}`,
      value: cratesDownloads,
    });
  }

  const stars = bySource.get("github") ?? 0;
  const starMilestone = biggestCrossed(stars, STAR_THRESHOLDS);
  if (starMilestone) {
    milestones.push({ key: `github-${starMilestone.key}`, title: `GitHub: ${starMilestone.title}`, value: stars });
  }

  const pulls = bySource.get("docker") ?? 0;
  const pullMilestone = biggestCrossed(pulls, PULL_THRESHOLDS);
  if (pullMilestone) {
    milestones.push({ key: `docker-${pullMilestone.key}`, title: `Docker: ${pullMilestone.title}`, value: pulls });
  }

  const imports = bySource.get("contracts") ?? contractsCount;
  const importMilestone = biggestCrossed(imports, IMPORT_THRESHOLDS);
  if (importMilestone) {
    milestones.push({
      key: `contracts-${importMilestone.key}`,
      title: `On-chain: ${importMilestone.title}`,
      value: imports,
    });
  }

  return { badges, milestones };
}

export function metricLabel(source: string, metricKey: string): string {
  const scale = SOURCE_SCALES[source];
  if (scale) return scale.label;
  return `${source}:${metricKey}`;
}
