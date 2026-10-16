import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { initDb } from "../src/db";

const ADMIN_KEY = "dev-admin-key";

describe("REST API", () => {
  let app: ReturnType<typeof createApp>;
  let repoId: string;

  beforeAll(() => {
    initDb(":memory:");
    app = createApp();
  });

  afterAll(() => {
    initDb(":memory:");
  });

  it("serves health", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("serves chain config", async () => {
    const res = await request(app).get("/api/chain/config");
    expect(res.status).toBe(200);
    expect(res.body.chainId).toBe(31337);
    expect(res.body.defaultSchemas.impactBadge.uid).toMatch(/^0x[0-9a-f]{64}$/);
  });

  describe("admin repository management", () => {
    it("rejects missing or wrong admin key", async () => {
      const payload = {
        name: "ethers.js",
        repoUrl: "https://github.com/ethers-io/ethers.js",
        packageType: "npm",
        packageName: "ethers",
      };
      expect((await request(app).post("/api/admin/repositories").send(payload)).status).toBe(401);
      expect(
        (await request(app).post("/api/admin/repositories").set("x-api-key", "wrong").send(payload)).status,
      ).toBe(401);
    });

    it("creates a repository with a valid admin key", async () => {
      const res = await request(app)
        .post("/api/admin/repositories")
        .set("x-api-key", ADMIN_KEY)
        .send({
          name: "ethers.js",
          repoUrl: "https://github.com/ethers-io/ethers.js",
          packageType: "npm",
          packageName: "ethers",
          githubRepo: "ethers-io/ethers.js",
          contractsCount: 800,
        });
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^ethers-js-/);
      repoId = res.body.id;
    });

    it("rejects duplicate repository URLs", async () => {
      const res = await request(app)
        .post("/api/admin/repositories")
        .set("x-api-key", ADMIN_KEY)
        .send({ name: "dupe", repoUrl: "https://github.com/ethers-io/ethers.js" });
      expect(res.status).toBe(409);
    });

    it("validates repository input", async () => {
      const res = await request(app)
        .post("/api/admin/repositories")
        .set("x-api-key", ADMIN_KEY)
        .send({ name: "", repoUrl: "not-a-url" });
      expect(res.status).toBe(400);
    });

    it("updates and deactivates a repository", async () => {
      const patched = await request(app)
        .patch(`/api/admin/repositories/${repoId}`)
        .set("x-api-key", ADMIN_KEY)
        .send({ description: "Updated description" });
      expect(patched.status).toBe(200);
      expect(patched.body.description).toBe("Updated description");

      const deleted = await request(app)
        .delete(`/api/admin/repositories/${repoId}`)
        .set("x-api-key", ADMIN_KEY);
      expect(deleted.status).toBe(200);
      expect(deleted.body.deactivated).toBe(repoId);
      // reactivate so later tests can use it
      const reactivated = await request(app)
        .patch(`/api/admin/repositories/${repoId}`)
        .set("x-api-key", ADMIN_KEY)
        .send({ active: true });
      expect(reactivated.status).toBe(200);
      expect(reactivated.body.active).toBe(true);
    });
  });

  it("lists repositories", async () => {
    const res = await request(app).get("/api/repositories");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.find((r: { id: string }) => r.id === repoId)).toBeDefined();
  });

  it("returns 404 for unknown repositories", async () => {
    expect((await request(app).get("/api/repositories/nope")).status).toBe(404);
    expect((await request(app).get("/api/repositories/nope/scorecard")).status).toBe(404);
  });

  describe("drip lists", () => {
    async function seedTwoRepos() {
      const r1 = await request(app).post("/api/admin/repositories").set("x-api-key", ADMIN_KEY).send({
        name: "Alpha",
        repoUrl: "https://github.com/a/alpha",
        id: "alpha",
      });
      const r2 = await request(app).post("/api/admin/repositories").set("x-api-key", ADMIN_KEY).send({
        name: "Beta",
        repoUrl: "https://github.com/b/beta",
        id: "beta",
      });
      return [r1, r2];
    }

    it("rejects splits that do not sum to 100", async () => {
      await seedTwoRepos();
      const res = await request(app).post("/api/drip-lists").send({
        name: "Bad list",
        splits: [
          { repoId: "alpha", percent: 30 },
          { repoId: "beta", percent: 30 },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sum to 100/);
    });

    it("rejects unknown repositories and duplicates", async () => {
      const res = await request(app).post("/api/drip-lists").send({
        name: "Bad list",
        splits: [
          { repoId: "alpha", percent: 50 },
          { repoId: "ghost", percent: 50 },
        ],
      });
      expect(res.status).toBe(404);
      const dup = await request(app).post("/api/drip-lists").send({
        name: "Dup",
        splits: [
          { repoId: "alpha", percent: 50 },
          { repoId: "alpha", percent: 50 },
        ],
      });
      expect(dup.status).toBe(400);
    });

    it("creates a valid drip list", async () => {
      const res = await request(app).post("/api/drip-lists").send({
        name: "My Impact List",
        description: "Backed by verified metrics",
        ownerAddress: "0x1234567890123456789012345678901234567890",
        splits: [
          { repoId: "alpha", percent: 40 },
          { repoId: "beta", percent: 60 },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^dl_/);
      expect(res.body.status).toBe("saved");
      expect(res.body.attestationUid).toBeNull();

      const listId = res.body.id;
      const got = await request(app).get(`/api/drip-lists/${listId}`);
      expect(got.status).toBe(200);
      expect(got.body.projects).toHaveLength(2);
      expect(got.body.manifestUri).toContain(listId);

      const meta = await request(app).get(`/api/metadata/drip-lists/${listId}.json`);
      expect(meta.status).toBe(200);
      expect(meta.body.totalPercent).toBe(100);
      expect(meta.body.splits).toHaveLength(2);
    });
  });

  describe("metadata", () => {
    it("serves repository attestation metadata", async () => {
      const res = await request(app).get(`/api/metadata/repositories/${repoId}/badge/verified-impact.json`);
      expect(res.status).toBe(200);
      expect(res.body.type).toBe("ImpactAttestation");
      expect(res.body.repository.id).toBe(repoId);
      expect(res.body.schema).toContain("repoUrl");
    });
  });

  describe("verification", () => {
    it("rejects malformed UIDs", async () => {
      const res = await request(app).get("/api/verify/not-a-uid");
      expect(res.status).toBe(400);
    });
  });
});
