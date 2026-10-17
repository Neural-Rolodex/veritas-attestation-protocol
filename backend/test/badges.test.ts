import { describe, expect, it } from "vitest";

import { deriveBadgesAndMilestones } from "../src/services/badges";

function metric(source: string, value: number, points = 50) {
  return { repoId: "x", source, metricKey: `${source}-m`, value, points, raw: null, recordedAt: "" };
}

describe("deriveBadgesAndMilestones", () => {
  it("awards verified-impact for high scores", () => {
    const { badges } = deriveBadgesAndMilestones(80, [metric("npm", 1000, 50)], 0);
    expect(badges.find((b) => b.key === "verified-impact")).toBeDefined();
  });

  it("does not award verified-impact for low scores", () => {
    const { badges } = deriveBadgesAndMilestones(40, [metric("npm", 1000, 50)], 0);
    expect(badges.find((b) => b.key === "verified-impact")).toBeUndefined();
  });

  it("awards high-adoption when any source points are high", () => {
    const { badges } = deriveBadgesAndMilestones(30, [metric("npm", 1000, 90)], 0);
    expect(badges.find((b) => b.key === "high-adoption")).toBeDefined();
  });

  it("awards broad-usage with three+ strong sources", () => {
    const { badges } = deriveBadgesAndMilestones(60, [
      metric("npm", 1, 50),
      metric("github", 1, 55),
      metric("docker", 1, 60),
    ], 0);
    expect(badges.find((b) => b.key === "broad-usage")).toBeDefined();
  });

  it("awards on-chain-adopted from contracts count", () => {
    const { badges } = deriveBadgesAndMilestones(30, [metric("contracts", 25, 50)], 25);
    expect(badges.find((b) => b.key === "on-chain-adopted")).toBeDefined();
  });

  it("derives the highest crossed milestone per source", () => {
    const { milestones } = deriveBadgesAndMilestones(50, [
      metric("npm", 2_500_000),
      metric("github", 45_000),
      metric("docker", 150_000_000),
      metric("contracts", 80),
    ], 80);
    expect(milestones.find((m) => m.key === "npm-1m-downloads")).toBeDefined();
    expect(milestones.find((m) => m.key === "npm-10m-downloads")).toBeUndefined();
    expect(milestones.find((m) => m.key === "github-10k-stars")).toBeDefined();
    expect(milestones.find((m) => m.key === "docker-100m-pulls")).toBeDefined();
    expect(milestones.find((m) => m.key === "contracts-50-imports")).toBeDefined();
  });

  it("produces no milestones for tiny metrics", () => {
    const { milestones } = deriveBadgesAndMilestones(10, [
      metric("npm", 500),
      metric("github", 10),
      metric("contracts", 0),
    ], 0);
    expect(milestones).toEqual([]);
  });
});
