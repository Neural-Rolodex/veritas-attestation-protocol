import type { SourceBreakdown } from "../types";

/**
 * Normalization scales: each source maps a raw value to 0-100 "points" using a
 * logarithmic scale so that a few huge projects do not dominate the score.
 * The ceiling is the value that produces 100 points.
 */
export const SOURCE_SCALES: Record<string, { metricKey: string; ceiling: number; label: string }> = {
  npm: { metricKey: "downloads_30d", ceiling: 5_000_000, label: "npm downloads (30d)" },
  crates: { metricKey: "downloads_90d", ceiling: 20_000_000, label: "crates.io downloads (90d)" },
  docker: { metricKey: "pulls", ceiling: 1_000_000_000, label: "Docker pulls (total)" },
  github: { metricKey: "stars", ceiling: 50_000, label: "GitHub stars" },
  contracts: { metricKey: "imports", ceiling: 300, label: "On-chain contract imports" },
};

export const SOURCE_WEIGHTS: Record<string, number> = {
  npm: 0.3,
  crates: 0.1,
  docker: 0.15,
  github: 0.25,
  contracts: 0.2,
};

export function clamp01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

/** Maps a raw metric value to a 0-100 point score for a source. */
export function pointsForSource(source: string, value: number): number {
  const scale = SOURCE_SCALES[source];
  if (!scale) return 0;
  if (value <= 0) return 0;
  // log scale: points = 100 * log10(1 + value) / log10(1 + ceiling)
  const points = (100 * Math.log10(1 + value)) / Math.log10(1 + scale.ceiling);
  return clamp01(points / 100) * 100;
}

/**
 * Computes the weighted impact score (0-100) from a set of metric points,
 * normalizing weights over the sources that actually have data.
 */
export function computeScore(
  metrics: { source: string; metricKey: string; value: number; points?: number }[],
): { score: number; breakdown: SourceBreakdown[] } {
  const bySource = new Map<string, { metricKey: string; value: number; points: number }>();
  for (const m of metrics) {
    const existing = bySource.get(m.source);
    // keep the first (primary) metric per source
    if (existing && m.value <= existing.value) continue;
    bySource.set(m.source, {
      metricKey: m.metricKey,
      value: m.value,
      points: m.points ?? pointsForSource(m.source, m.value),
    });
  }

  const entries = [...bySource.entries()].filter(
    ([source, v]) => v.value > 0 && SOURCE_WEIGHTS[source] !== undefined,
  );
  const totalWeight = entries.reduce((acc, [source]) => acc + (SOURCE_WEIGHTS[source] ?? 0), 0);
  if (totalWeight === 0) {
    return { score: 0, breakdown: [] };
  }

  const breakdown: SourceBreakdown[] = entries.map(([source, v]) => {
    const weight = (SOURCE_WEIGHTS[source] ?? 0) / totalWeight;
    return {
      source,
      metricKey: v.metricKey,
      value: v.value,
      points: Math.round(v.points * 100) / 100,
      weight: Math.round(weight * 1000) / 1000,
      contribution: Math.round(v.points * weight * 10) / 10,
    };
  });

  const score = Math.round(breakdown.reduce((acc, b) => acc + b.contribution, 0));
  return { score: Math.min(100, Math.max(0, score)), breakdown };
}

/**
 * The oracle signs a snapshot of this canonical metrics payload. Changing the
 * shape changes the hash, so consumers can detect tampering.
 */
export function canonicalize(metrics: { source: string; metricKey: string; value: number }[]): string {
  const sorted = [...metrics]
    .map((m) => `${m.source}:${m.metricKey}:${m.value}`)
    .sort();
  return sorted.join("\n");
}
