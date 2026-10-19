import { describe, expect, it } from "vitest";

import { signSnapshot, snapshotHashOf, verifySnapshot } from "../src/services/signer";

describe("oracle snapshot signing (EIP-712)", () => {
  it("produces a signature that verifies against the oracle address", async () => {
    const signed = await signSnapshot({
      repoId: "ethers",
      score: 87,
      snapshotHash: snapshotHashOf("npm:downloads_30d:1200000\ngithub:stars:12000"),
      timestamp: 1_700_000_000_000,
    });

    expect(signed.signer).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(signed.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);

    const valid = await verifySnapshot(signed);
    expect(valid).toBe(true);
  });

  it("rejects tampered messages", async () => {
    const signed = await signSnapshot({
      repoId: "ethers",
      score: 87,
      snapshotHash: snapshotHashOf("npm:downloads_30d:1200000"),
      timestamp: 1_700_000_000_000,
    });
    const tampered = await verifySnapshot({
      ...signed,
      message: { ...signed.message, score: 100 },
    });
    expect(tampered).toBe(false);
  });

  it("rejects signatures from a different signer", async () => {
    const signed = await signSnapshot({
      repoId: "ethers",
      score: 87,
      snapshotHash: snapshotHashOf("npm:downloads_30d:1200000"),
      timestamp: 1_700_000_000_000,
    });
    const impostor = await verifySnapshot({
      ...signed,
      signer: "0x0000000000000000000000000000000000000001",
    });
    expect(impostor).toBe(false);
  });
});
