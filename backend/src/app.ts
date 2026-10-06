import { randomBytes, randomUUID } from "node:crypto";

import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import { config, schemaUid } from "./config";
import {
  createDripList,
  createRepository,
  getDripList,
  getRepository,
  getRepositoryByUrl,
  insertAttestation,
  latestMetricsBySource,
  latestScore,
  listActiveRepositories,
  listAttestations,
  listDripLists,
  listRepositories,
  setDripListAttestation,
  setRepositoryActive,
  updateRepository,
} from "./db";
import * as attester from "./services/attester";
import { deriveBadgesAndMilestones } from "./services/badges";
import { refreshAll, refreshRepo } from "./services/pipeline";
import { canonicalize, computeScore } from "./services/scoreEngine";
import { oracleAddress, signSnapshot, snapshotHashOf } from "./services/signer";
import type { Badge, DripList, Repository, RepositoryInput, Scorecard } from "./types";

export function createApp(): express.Express {
  const app = express();
  app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") }));
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    if (process.env.NODE_ENV !== "test") {
      console.log(`${req.method} ${req.url}`);
    }
    next();
  });

  // ---------- health & chain ----------

  app.get("/api", (_req, res) => {
    res.json({
      name: "Veritas Attestation Protocol API",
      version: "0.1.0",
      endpoints: [
        "GET /api/health",
        "GET /api/chain/config",
        "GET /api/repositories",
        "GET /api/repositories/:id",
        "GET /api/repositories/:id/scorecard",
        "GET /api/repositories/:id/attestations",
        "GET /api/drip-lists",
        "POST /api/drip-lists",
        "GET /api/drip-lists/:id",
        "POST /api/drip-lists/:id/attest",
        "GET /api/verify/:uid",
        "GET /api/metadata/...",
        "POST /api/admin/repositories",
        "PATCH /api/admin/repositories/:id",
        "POST /api/admin/repositories/:id/refresh",
        "POST /api/admin/pipeline/run",
      ],
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, chain: Boolean(config.registryAddress ?? config.chain.impactRegistry), time: new Date().toISOString() });
  });

  app.get("/api/chain/config", (_req, res) => {
    res.json({
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      easAddress: (config.easAddress ?? config.chain.eas) || null,
      registryAddress: (config.registryAddress ?? config.chain.impactRegistry) || null,
      oracle: config.chain.oracle || oracleAddress(),
      explorerUrl: config.explorerUrl ?? null,
      schemas: config.chain.schemas.impactBadge.uid ? config.chain.schemas : undefined,
      defaultSchemas: {
        impactBadge: { uid: schemaUid(config.chain.schemas.impactBadge.schema), schema: config.chain.schemas.impactBadge.schema },
        milestone: { uid: schemaUid(config.chain.schemas.milestone.schema), schema: config.chain.schemas.milestone.schema },
        dripList: { uid: schemaUid(config.chain.schemas.dripList.schema), schema: config.chain.schemas.dripList.schema },
      },
    });
  });

  // ---------- repositories ----------

  function summarize(repo: Repository): Record<string, unknown> {
    const snapshot = latestScore(repo.id);
    const metrics = latestMetricsBySource(repo.id);
    const score = snapshot?.score ?? computeScore(metrics).score;
    const { badges } = deriveBadgesAndMilestones(score, metrics, repo.contractsCount);
    return { ...repo, score, badges };
  }

  app.get("/api/repositories", (_req, res) => {
    const repos = listActiveRepositories();
    res.json(repos.map(summarize));
  });

  app.get("/api/repositories/:id", (req, res) => {
    const repo = getRepository(req.params.id!);
    if (!repo) return res.status(404).json({ error: "Repository not found" });
    res.json(summarize(repo));
  });

  app.get("/api/repositories/:id/attestations", (req, res) => {
    const repo = getRepository(req.params.id!);
    if (!repo) return res.status(404).json({ error: "Repository not found" });
    res.json(listAttestations(repo.id));
  });

  async function buildScorecard(repoId: string): Promise<Scorecard> {
    const repo = getRepository(repoId);
    if (!repo) throw new RepoNotFoundError();

    const metrics = latestMetricsBySource(repoId);
    const snapshot = latestScore(repoId);
    const computed = computeScore(metrics);
    const score = snapshot?.score ?? computed.score;
    const breakdown = snapshot?.breakdown ?? computed.breakdown;
    const { badges, milestones } = deriveBadgesAndMilestones(score, metrics, repo.contractsCount);
    const attestations = listAttestations(repoId);

    const snapshotHash = snapshotHashOf(canonicalize(metrics));
    let oracle = { signer: "", timestamp: 0, signature: "" };
    try {
      const signed = await signSnapshot({ repoId, score, snapshotHash, timestamp: Date.now() });
      oracle = { signer: signed.signer, timestamp: signed.message.timestamp, signature: signed.signature };
    } catch {
      // signing unavailable; oracle block stays empty
    }

    let onChain = { registered: false, registryAddress: null as string | null, chainId: config.chainId };
    try {
      const existing = await attester.readRepository(repo);
      onChain = {
        registered: existing?.active === true,
        registryAddress: attester.registryAddress(),
        chainId: config.chainId,
      };
    } catch {
      // chain unreachable
    }

    return {
      repository: repo,
      score,
      breakdown,
      metrics,
      badges,
      milestones,
      snapshotHash,
      computedAt: snapshot?.computedAt ?? new Date().toISOString(),
      oracle,
      attestations,
      onChain,
    };
  }

  app.get("/api/repositories/:id/scorecard", async (req, res) => {
    try {
      res.json(await buildScorecard(req.params.id));
    } catch (error) {
      if (error instanceof RepoNotFoundError) return res.status(404).json({ error: "Repository not found" });
      throw error;
    }
  });

  // ---------- verification ----------

  app.get("/api/verify/:uid", async (req, res) => {
    const uid = req.params.uid.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(uid)) {
      return res.status(400).json({ error: "Attestation UID must be a 32-byte hex string" });
    }
    try {
      const attestation = await attester.readAttestation(uid);
      if (!attestation) return res.status(404).json({ error: "No attestation found for this UID" });
      res.json({ ...attestation, verified: attestation.revocationTime === 0 });
    } catch (error) {
      res.status(503).json({ error: `Unable to reach the chain: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  // ---------- drip lists ----------

  app.get("/api/drip-lists", (_req, res) => {
    res.json(listDripLists());
  });

  const dripListSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional().default(""),
    ownerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    splits: z
      .array(z.object({ repoId: z.string().min(1), percent: z.number().int().min(1).max(100) }))
      .min(2)
      .max(50),
  });

  app.post("/api/drip-lists", (req, res) => {
    const parsed = dripListSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid drip list", details: parsed.error.flatten() });
    }
    const { name, description, ownerAddress, splits } = parsed.data;

    const total = splits.reduce((acc, s) => acc + s.percent, 0);
    if (total !== 100) {
      return res.status(400).json({ error: `Percentages must sum to 100 (got ${total})` });
    }
    const seen = new Set<string>();
    for (const s of splits) {
      if (seen.has(s.repoId)) return res.status(400).json({ error: `Duplicate project in splits: ${s.repoId}` });
      seen.add(s.repoId);
      if (!getRepository(s.repoId)) return res.status(404).json({ error: `Unknown repository: ${s.repoId}` });
    }

    const id = `dl_${randomBytes(6).toString("hex")}`;
    const list = createDripList({ id, name, description: description || null, ownerAddress, splits });
    res.status(201).json(list);
  });

  app.get("/api/drip-lists/:id", (req, res) => {
    const list = getDripList(req.params.id);
    if (!list) return res.status(404).json({ error: "Drip list not found" });
    res.json(enrichDripList(list));
  });

  function enrichDripList(list: DripList): Record<string, unknown> {
    const projects = list.splits.map((s) => {
      const repo = getRepository(s.repoId);
      return {
        repoId: s.repoId,
        percent: s.percent,
        name: repo?.name ?? s.repoId,
        repoUrl: repo?.repoUrl ?? null,
        score: repo ? (latestScore(repo.id)?.score ?? null) : null,
      };
    });
    return { ...list, projects, manifestUri: `${config.publicBaseUrl}/api/metadata/drip-lists/${list.id}.json` };
  }

  app.post("/api/drip-lists/:id/attest", async (req, res) => {
    const list = getDripList(req.params.id);
    if (!list) return res.status(404).json({ error: "Drip list not found" });
    if (list.attestationUid) {
      return res.status(409).json({ error: "Drip list already attested", attestationUid: list.attestationUid });
    }
    const metadataUri = `${config.publicBaseUrl}/api/metadata/drip-lists/${list.id}.json`;
    try {
      const result = await attester.attestDripList(metadataUri);
      const updated = setDripListAttestation(list.id, result.uid);
      insertAttestation({
        uid: result.uid,
        repoId: null,
        kind: "drip-list",
        title: list.id,
        value: null,
        status: "confirmed",
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        metadataUri,
        note: null,
      });
      res.json({ ...enrichDripList(updated ?? list), attestationUid: result.uid, txHash: result.txHash, blockNumber: result.blockNumber });
    } catch (error) {
      res.status(502).json({ error: `Attestation failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  // ---------- attestation metadata (resolvable URIs) ----------

  app.get("/api/metadata/repositories/:repoId/:kind/:title.json", (req, res) => {
    const repo = getRepository(req.params.repoId);
    if (!repo) return res.status(404).json({ error: "Repository not found" });
    const kind = req.params.kind;
    const title = decodeURIComponent(req.params.title);
    const metrics = latestMetricsBySource(repo.id);
    const snapshot = latestScore(repo.id);
    const score = snapshot?.score ?? computeScore(metrics).score;

    const matching = listAttestations(repo.id).find((a) => a.kind === kind && a.title === title);
    res.json({
      type: "ImpactAttestation",
      kind,
      title,
      value: matching?.value ?? null,
      status: matching?.status ?? null,
      uid: matching?.uid ?? null,
      score,
      repository: { id: repo.id, name: repo.name, repoUrl: repo.repoUrl, packageType: repo.packageType },
      metrics: metrics.map((m) => ({ source: m.source, metricKey: m.metricKey, value: m.value })),
      schema:
        kind === "milestone"
          ? config.chain.schemas.milestone.schema
          : kind === "score"
            ? config.chain.schemas.impactBadge.schema
            : config.chain.schemas.impactBadge.schema,
      attester: oracleAddress(),
      generatedAt: new Date().toISOString(),
    });
  });

  app.get("/api/metadata/drip-lists/:id.json", (req, res) => {
    const list = getDripList(req.params.id);
    if (!list) return res.status(404).json({ error: "Drip list not found" });
    const projects = list.splits.map((s) => {
      const repo = getRepository(s.repoId);
      return { repoId: s.repoId, name: repo?.name ?? s.repoId, repoUrl: repo?.repoUrl ?? null, percent: s.percent };
    });
    res.json({
      type: "DripList",
      id: list.id,
      name: list.name,
      description: list.description,
      ownerAddress: list.ownerAddress,
      totalPercent: 100,
      splits: projects,
      createdAt: list.createdAt,
      attestationUid: list.attestationUid,
      schema: config.chain.schemas.dripList.schema,
      attester: oracleAddress(),
      note: "Impact-backed funding list produced by the Veritas Attestation Protocol.",
    });
  });

  // ---------- admin ----------

  function adminAuth(req: Request, res: Response, next: NextFunction) {
    const key = req.header("x-api-key");
    if (!config.adminApiKey || key !== config.adminApiKey) {
      return res.status(401).json({ error: "Invalid or missing admin API key" });
    }
    next();
  }

  const repoInputSchema = z.object({
    id: z.string().min(1).max(80).optional(),
    name: z.string().min(1).max(200),
    repoUrl: z.string().url(),
    description: z.string().max(2000).optional(),
    packageType: z.string().max(80).optional(),
    packageName: z.string().max(200).optional(),
    crateName: z.string().max(200).optional(),
    githubRepo: z.string().max(200).optional(),
    dockerImage: z.string().max(200).optional(),
    contractsCount: z.number().int().min(0).optional(),
    ownerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    metadataUri: z.string().max(500).optional(),
    active: z.boolean().optional(),
  });

  function toInput(data: z.infer<typeof repoInputSchema>, id: string): RepositoryInput & { id: string } {
    return {
      id,
      name: data.name,
      repoUrl: data.repoUrl,
      description: data.description ?? null,
      packageType: data.packageType ?? null,
      packageName: data.packageName ?? null,
      crateName: data.crateName ?? null,
      githubRepo: data.githubRepo ?? null,
      dockerImage: data.dockerImage ?? null,
      contractsCount: data.contractsCount ?? 0,
      ownerAddress: data.ownerAddress ?? null,
      metadataUri: data.metadataUri ?? null,
    };
  }

  app.post("/api/admin/repositories", adminAuth, (req, res) => {
    const parsed = repoInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid repository", details: parsed.error.flatten() });
    }
    const existing = getRepositoryByUrl(parsed.data.repoUrl);
    if (existing) {
      return res.status(409).json({ error: "Repository with this URL already exists", id: existing.id });
    }
    const id = parsed.data.id ?? slugify(parsed.data.name, parsed.data.repoUrl);
    if (getRepository(id)) {
      return res.status(409).json({ error: `Repository id already exists: ${id}` });
    }
    const repo = createRepository(toInput(parsed.data, id));
    res.status(201).json(repo);
  });

  app.patch("/api/admin/repositories/:id", adminAuth, (req, res) => {
    const repo = getRepository(req.params.id!);
    if (!repo) return res.status(404).json({ error: "Repository not found" });
    const parsed = repoInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid repository", details: parsed.error.flatten() });
    }
    const { active, ...fields } = parsed.data;
    const updated = updateRepository(repo.id, toInput(fields as never, repo.id));
    if (active !== undefined) setRepositoryActive(repo.id, active);
    res.json(active !== undefined ? getRepository(repo.id) : updated);
  });

  app.delete("/api/admin/repositories/:id", adminAuth, (req, res) => {
    const repo = getRepository(req.params.id!);
    if (!repo) return res.status(404).json({ error: "Repository not found" });
    setRepositoryActive(repo.id, false);
    res.json({ ok: true, deactivated: repo.id });
  });

  app.post("/api/admin/repositories/:id/refresh", adminAuth, async (_req, res) => {
    const repo = getRepository(_req.params.id!);
    if (!repo) return res.status(404).json({ error: "Repository not found" });
    try {
      const result = await refreshRepo(repo.id);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/admin/pipeline/run", adminAuth, async (_req, res) => {
    const results = await refreshAll();
    res.json({ refreshed: results.length, results });
  });

  // ---------- errors ----------

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api] error:", error);
    res.status(500).json({ error: message });
  });

  return app;
}

class RepoNotFoundError extends Error {}

function slugify(name: string, repoUrl: string): string {
  const fromName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  if (fromName) return `${fromName}-${randomUUID().slice(0, 8)}`;
  const fromUrl = repoUrl.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return `${fromUrl}-${randomUUID().slice(0, 8)}`;
}
