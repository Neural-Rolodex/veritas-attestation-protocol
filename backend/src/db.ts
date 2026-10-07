import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { config } from "./config";
import type {
  Attestation,
  AttestationStatus,
  DripList,
  DripSplit,
  MetricPoint,
  Repository,
  RepositoryInput,
  ScoreSnapshot,
} from "./types";

// Loaded via createRequire so bundlers/transpilers (vitest, vite) treat it as a
// plain native builtin instead of trying to resolve "node:sqlite".
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncType = import("node:sqlite").DatabaseSync;
type SQLInputValue = import("node:sqlite").SQLInputValue;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL UNIQUE,
  description TEXT,
  package_type TEXT,
  package_name TEXT,
  crate_name TEXT,
  github_repo TEXT,
  docker_image TEXT,
  contracts_count INTEGER NOT NULL DEFAULT 0,
  owner_address TEXT,
  metadata_uri TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_attested_at TEXT
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  source TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  value REAL NOT NULL,
  points REAL NOT NULL,
  raw TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metrics_repo ON metrics (repo_id, recorded_at);

CREATE TABLE IF NOT EXISTS score_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL,
  breakdown TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attestations (
  uid TEXT PRIMARY KEY,
  repo_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  value REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  block_number INTEGER,
  metadata_uri TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attestations_repo ON attestations (repo_id);

CREATE TABLE IF NOT EXISTS drip_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner_address TEXT,
  splits TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'saved',
  attestation_uid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let db: DatabaseSyncType | null = null;

export function initDb(path?: string): DatabaseSyncType {
  if (db) {
    db.close();
    db = null;
  }
  const file = path ?? config.databasePath;
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function getDb(): DatabaseSyncType {
  if (!db) return initDb();
  return db;
}

// ---- repositories ----

function rowToRepository(row: any): Repository {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    description: row.description,
    packageType: row.package_type,
    packageName: row.package_name,
    crateName: row.crate_name,
    githubRepo: row.github_repo,
    dockerImage: row.docker_image,
    contractsCount: row.contracts_count,
    ownerAddress: row.owner_address,
    metadataUri: row.metadata_uri,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAttestedAt: row.last_attested_at,
  };
}

const REPO_COLS =
  "id, name, repo_url, description, package_type, package_name, crate_name, github_repo, docker_image, contracts_count, owner_address, metadata_uri, active, created_at, updated_at, last_attested_at";

export function listRepositories(): Repository[] {
  const rows = getDb()
    .prepare(`SELECT ${REPO_COLS} FROM repositories ORDER BY name ASC`)
    .all();
  return rows.map(rowToRepository);
}

export function listActiveRepositories(): Repository[] {
  const rows = getDb()
    .prepare(`SELECT ${REPO_COLS} FROM repositories WHERE active = 1 ORDER BY name ASC`)
    .all();
  return rows.map(rowToRepository);
}

export function getRepository(id: string): Repository | undefined {
  const row = getDb().prepare(`SELECT ${REPO_COLS} FROM repositories WHERE id = ?`).get(id);
  return row ? rowToRepository(row) : undefined;
}

export function getRepositoryByUrl(repoUrl: string): Repository | undefined {
  const row = getDb().prepare(`SELECT ${REPO_COLS} FROM repositories WHERE repo_url = ?`).get(repoUrl);
  return row ? rowToRepository(row) : undefined;
}

export function createRepository(input: RepositoryInput & { id: string }): Repository {
  const db = getDb();
  db.prepare(
    `INSERT INTO repositories
      (id, name, repo_url, description, package_type, package_name, crate_name, github_repo, docker_image, contracts_count, owner_address, metadata_uri)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.repoUrl,
    input.description ?? null,
    input.packageType ?? null,
    input.packageName ?? null,
    input.crateName ?? null,
    input.githubRepo ?? null,
    input.dockerImage ?? null,
    input.contractsCount ?? 0,
    input.ownerAddress ?? null,
    input.metadataUri ?? null,
  );
  return getRepository(input.id)!;
}

export function updateRepository(id: string, fields: Partial<RepositoryInput>): Repository | undefined {
  const db = getDb();
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  const map: Record<string, keyof RepositoryInput> = {
    name: "name",
    repo_url: "repoUrl",
    description: "description",
    package_type: "packageType",
    package_name: "packageName",
    crate_name: "crateName",
    github_repo: "githubRepo",
    docker_image: "dockerImage",
    contracts_count: "contractsCount",
    owner_address: "ownerAddress",
    metadata_uri: "metadataUri",
  };
  for (const [col, key] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = ?`);
      values.push(fields[key] ?? null);
    }
  }
  if (sets.length === 0) return getRepository(id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE repositories SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getRepository(id);
}

export function setRepositoryActive(id: string, active: boolean): void {
  getDb().prepare("UPDATE repositories SET active = ?, updated_at = datetime('now') WHERE id = ?").run(active ? 1 : 0, id);
}

export function setRepositoryAttested(id: string, at = new Date().toISOString()): void {
  getDb()
    .prepare("UPDATE repositories SET last_attested_at = ? WHERE id = ?")
    .run(at, id);
}

// ---- metrics ----

export function insertMetric(m: Omit<MetricPoint, "recordedAt">): void {
  getDb()
    .prepare(
      "INSERT INTO metrics (repo_id, source, metric_key, value, points, raw) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(m.repoId, m.source, m.metricKey, m.value, m.points, JSON.stringify(m.raw ?? null));
}

export function listMetrics(repoId: string): MetricPoint[] {
  const rows = getDb()
    .prepare("SELECT * FROM metrics WHERE repo_id = ? ORDER BY recorded_at DESC, id DESC")
    .all(repoId);
  return rows.map(rowToMetric);
}

function rowToMetric(row: any): MetricPoint {
  return {
    repoId: row.repo_id,
    source: row.source,
    metricKey: row.metric_key,
    value: row.value,
    points: row.points,
    raw: row.raw ? JSON.parse(row.raw) : null,
    recordedAt: row.recorded_at,
  };
}

export function latestMetricsBySource(repoId: string): MetricPoint[] {
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM metrics m
       INNER JOIN (SELECT source, MAX(id) AS max_id FROM metrics WHERE repo_id = ? GROUP BY source) latest
       ON m.id = latest.max_id`,
    )
    .all(repoId);
  return rows.map(rowToMetric);
}

export function deleteMetricsForRepo(repoId: string): void {
  getDb().prepare("DELETE FROM metrics WHERE repo_id = ?").run(repoId);
}

// ---- score snapshots ----

export function insertScore(snapshot: Omit<ScoreSnapshot, "computedAt">): void {
  const db = getDb();
  db.prepare("DELETE FROM score_snapshots WHERE repo_id = ?").run(snapshot.repoId);
  db.prepare("INSERT INTO score_snapshots (repo_id, score, breakdown) VALUES (?, ?, ?)").run(
    snapshot.repoId,
    snapshot.score,
    JSON.stringify(snapshot.breakdown),
  );
}

export function latestScore(repoId: string): ScoreSnapshot | undefined {
  const row = getDb().prepare("SELECT * FROM score_snapshots WHERE repo_id = ?").get(repoId);
  if (!row) return undefined;
  return rowToScore(row);
}

function rowToScore(row: any): ScoreSnapshot {
  return {
    repoId: row.repo_id,
    score: row.score,
    breakdown: JSON.parse(row.breakdown),
    computedAt: row.computed_at,
  };
}

// ---- attestations ----

export function insertAttestation(a: Omit<Attestation, "createdAt">): void {
  getDb()
    .prepare(
      `INSERT INTO attestations (uid, repo_id, kind, title, value, status, tx_hash, block_number, metadata_uri, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         status = excluded.status,
         tx_hash = excluded.tx_hash,
         block_number = excluded.block_number,
         metadata_uri = excluded.metadata_uri,
         note = excluded.note`,
    )
    .run(
      a.uid,
      a.repoId ?? null,
      a.kind,
      a.title,
      a.value ?? null,
      a.status,
      a.txHash ?? null,
      a.blockNumber ?? null,
      a.metadataUri ?? null,
      a.note ?? null,
    );
}

function rowToAttestation(row: any): Attestation {
  return {
    uid: row.uid,
    repoId: row.repo_id,
    kind: row.kind,
    title: row.title,
    value: row.value,
    status: row.status,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    metadataUri: row.metadata_uri,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function listAttestations(repoId?: string): Attestation[] {
  const rows = repoId
    ? getDb()
        .prepare("SELECT * FROM attestations WHERE repo_id = ? ORDER BY created_at DESC")
        .all(repoId)
    : getDb().prepare("SELECT * FROM attestations ORDER BY created_at DESC").all();
  return rows.map(rowToAttestation);
}

export function getAttestation(uid: string): Attestation | undefined {
  const row = getDb().prepare("SELECT * FROM attestations WHERE uid = ?").get(uid);
  return row ? rowToAttestation(row) : undefined;
}

export function hasAttestation(args: { repoId?: string; kind: string; title: string; value?: number }): boolean {
  const { repoId, kind, title, value } = args;
  let sql = "SELECT 1 FROM attestations WHERE kind = ? AND title = ? AND status != 'failed'";
  const params: SQLInputValue[] = [kind, title];
  if (repoId) {
    sql += " AND repo_id = ?";
    params.push(repoId);
  }
  if (value !== undefined) {
    sql += " AND value = ?";
    params.push(value);
  }
  sql += " LIMIT 1";
  return Boolean(getDb().prepare(sql).get(...params));
}

export function latestConfirmedByTitle(repoId: string, kind: string, title: string): Attestation | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM attestations WHERE repo_id = ? AND kind = ? AND title = ? AND status = 'confirmed' ORDER BY created_at DESC LIMIT 1",
    )
    .get(repoId, kind, title);
  return row ? rowToAttestation(row) : undefined;
}

export function updateAttestation(
  uid: string,
  fields: Partial<Pick<Attestation, "status" | "txHash" | "blockNumber" | "note">>,
): void {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  const map: Record<string, keyof Pick<Attestation, "status" | "txHash" | "blockNumber" | "note">> = {
    status: "status",
    tx_hash: "txHash",
    block_number: "blockNumber",
    note: "note",
  };
  for (const [col, key] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = ?`);
      values.push(fields[key] ?? null);
    }
  }
  if (sets.length === 0) return;
  values.push(uid);
  getDb().prepare(`UPDATE attestations SET ${sets.join(", ")} WHERE uid = ?`).run(...values);
}

export function deleteFailedAttestations(): void {
  getDb().prepare("DELETE FROM attestations WHERE status = 'failed'").run();
}

// ---- drip lists ----

export function createDripList(input: {
  id: string;
  name: string;
  description?: string | null;
  ownerAddress?: string | null;
  splits: DripSplit[];
}): DripList {
  getDb()
    .prepare(
      "INSERT INTO drip_lists (id, name, description, owner_address, splits) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      input.id,
      input.name,
      input.description ?? null,
      input.ownerAddress ?? null,
      JSON.stringify(input.splits),
    );
  return getDripList(input.id)!;
}

function rowToDripList(row: any): DripList {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerAddress: row.owner_address,
    splits: JSON.parse(row.splits) as DripSplit[],
    status: row.status,
    attestationUid: row.attestation_uid,
    createdAt: row.created_at,
  };
}

export function getDripList(id: string): DripList | undefined {
  const row = getDb().prepare("SELECT * FROM drip_lists WHERE id = ?").get(id);
  return row ? rowToDripList(row) : undefined;
}

export function listDripLists(): DripList[] {
  const rows = getDb().prepare("SELECT * FROM drip_lists ORDER BY created_at DESC").all();
  return rows.map(rowToDripList);
}

export function setDripListAttestation(id: string, uid: string): DripList | undefined {
  getDb().prepare("UPDATE drip_lists SET attestation_uid = ?, status = 'attested' WHERE id = ?").run(uid, id);
  return getDripList(id);
}

export function setDripListStatus(id: string, status: "saved" | "attested"): void {
  getDb().prepare("UPDATE drip_lists SET status = ? WHERE id = ?").run(status, id);
}
