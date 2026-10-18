import { describe, expect, it } from "vitest";

import { canonicalize, clamp01, computeScore, pointsForSource } from "../src/services/scoreEngine";

describe("pointsForSource", () => {
  it("returns 0 for non-positive values and unknown sources", () => {
    expect(pointsForSource("npm", 0)).toBe(0);
    expect(pointsForSource("npm", -5)).toBe(0);
    expect(pointsForSource("unknown", 100)).toBe(0);
  });

  it("reaches 100 at the scale ceiling", () => {
    expect(pointsForSource("npm", 5_000_000)).toBe(100);
    expect(pointsForSource("contracts", 300)).toBe(100);
  });

  it("is monotonic and grows logarithmically", () => {
    const low = pointsForSource("npm", 1_000);
    const mid = pointsForSource("npm", 100_000);
    const high = pointsForSource("npm", 1_000_000);
    expect(low).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });
});

describe("computeScore", () => {
  it("computes a weighted score across sources", () => {
    const metrics = [
      { source: "npm", metricKey: "downloads_30d", value: 1_000_000 },
      { source: "github", metricKey: "stars", value: 25_000 },
      { source: "contracts", metricKey: "imports", value: 100 },
    ];
    const { score, breakdown } = computeScore(metrics);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(breakdown.length).toBe(3);
    // npm weight 0.3/(0.3+0.25+0.2) = 0.4
    const npm = breakdown.find((b) => b.source === "npm");
    expect(npm).toBeDefined();
    expect(npm!.weight).toBeCloseTo(0.4, 1);
    expect(Math.round(breakdown.reduce((acc, b) => acc + b.contribution, 0))).toBe(score);
  });

  it("returns score 0 and empty breakdown when no metrics exist", () => {
    const { score, breakdown } = computeScore([]);
    expect(score).toBe(0);
    expect(breakdown).toEqual([]);
  });

  it("normalizes weights when some sources are missing", () => {
    const a = computeScore([{ source: "npm", metricKey: "downloads_30d", value: 100_000 }]);
    const b = computeScore([{ source: "npm", metricKey: "downloads_30d", value: 100_000 }, { source: "contracts", metricKey: "imports", value: 300 }]);
    // with a second perfect source the npm contribution should drop
    const npmA = a.breakdown[0]!.contribution;
    const npmB = b.breakdown.find((x) => x.source === "npm")!.contribution;
    expect(npmB).toBeLessThan(npmA);
  });

  it("ignores sources without a defined weight", () => {
    const { breakdown } = computeScore([
      { source: "npm", metricKey: "downloads_30d", value: 100_000 },
      { source: "github-forks", metricKey: "forks", value: 900 },
    ]);
    expect(breakdown.some((b) => b.source === "github-forks")).toBe(false);
  });

  it("clamps the score to the 0-100 range", () => {
    const { score } = computeScore([{ source: "contracts", metricKey: "imports", value: 1_000_000 }]);
    expect(score).toBe(100);
  });
});

describe("canonicalize", () => {
  it("produces a stable, order-independent canonical form", () => {
    const a = canonicalize([{ source: "npm", metricKey: "downloads_30d", value: 10 }, { source: "github", metricKey: "stars", value: 20 }]);
    const b = canonicalize([{ source: "github", metricKey: "stars", value: 20 }, { source: "npm", metricKey: "downloads_30d", value: 10 }]);
    const c = canonicalize([{ source: "npm", metricKey: "downloads_30d", value: 11 }, { source: "github", metricKey: "stars", value: 20 }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("clamp01", () => {
  it("clamps values into [0,1]", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
});
