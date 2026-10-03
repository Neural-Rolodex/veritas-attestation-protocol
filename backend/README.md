# Veritas Attestation Protocol — Backend

The backend oracle for the Veritas Attestation Protocol. It indexes real, public
metrics for open-source repositories, computes a weighted **impact score**,
derives **badges** and **milestones**, and mints verifiable **EAS attestations**
on-chain through the registry smart contract. It also serves a REST API for
scorecards, attestation verification, and impact-backed **Drip Lists**.

Built with TypeScript, Express, Viem, Zod, and Node's built-in SQLite.

## Table of contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [The scoring model](#the-scoring-model)
- [Badges and milestones](#badges-and-milestones)
- [Attestation lifecycle](#attestation-lifecycle)
- [REST API](#rest-api)
- [Environment variables](#environment-variables)
- [Project layout](#project-layout)
- [Getting started](#getting-started)
- [Scripts](#scripts)
- [Testing](#testing)

## How it works

1. **Repositories** are registered (via the admin API or the seed script). Each
   repository points at one or more data sources: npm, crates.io, Docker Hub,
   GitHub, or on-chain contract usage.
2. The **ingestion pipeline** refreshes metrics for every active repository on a
   schedule (default every 6 h). Each source maps a raw value to `0–100` points.
3. The **score engine** combines the points into a weighted `0–100` impact score,
   normalizing weights over the sources that actually have data.
4. **Badges and milestones** are derived from the score and the raw metrics.
5. New/changed items are **attested on-chain**: the backend signs transactions as
   the registry's `oracle`, the registry mints EAS attestations, and the results
   are stored locally as `confirmed`.
6. The **REST API** exposes scorecards, metrics, attestations, a cryptographic
   oracle signature over each snapshot, and an on-chain verification endpoint.

## Architecture

```
                ┌───────────────────────────────────────────────┐
                │                     backend                    │
                │                                               │
  npm / crates  │  ┌──────────┐     ┌────────────┐               │
  docker / gh   │  │ sources  │────▶│  pipeline  │               │
  contracts     │  └──────────┘     └─────┬──────┘               │
                │                         │ metrics/score        │
                │                         ▼                      │
                │              ┌──────────────────────┐          │
                │              │   score engine +     │          │
                │              │   badges/milestones  │          │
                │              └──────────┬───────────┘          │
                │                         │ attestations         │
                │                         ▼                      │
                │              ┌──────────────────────┐          │
                │              │      attester        │          │
                │              │ (oracle, viem/EAS)   │          │
                │              └──────────┬───────────┘          │
                └─────────────────────────┼──────────────────────┘
                                          │ RPC (write: mint/register)
                                          ▼
                          ImpactAttestationRegistry (contracts/)
                                          │ mint
                                          ▼
                                    EAS (on-chain)
                ┌───────────────────────────────────────────────┐
                │        REST API  (app.ts → server.ts)         │
                │  scorecards · attestations · verify · drips   │
                └───────────────────────────────────────────────┘
```

- `src/services/pipeline.ts` — orchestration: fetch → score → derive → attest.
- `src/services/scoreEngine.ts` — normalization, weighting, canonical snapshot hashing.
- `src/services/badges.ts` — badge/milestone thresholds.
- `src/services/attester.ts` — on-chain read/write via the registry + EAS.
- `src/services/signer.ts` — EIP-712 snapshot signing with the oracle key.
- `src/db.ts` — SQLite persistence (repositories, metrics, scores, attestations, drip lists).
- `src/app.ts` — Express REST API.

## The scoring model

Each data source normalizes its raw value to `0–100` points on a **logarithmic
scale**, so a handful of huge projects do not dominate the score:

```
points = 100 · log10(1 + value) / log10(1 + ceiling)
```

| Source    | Metric               | Ceiling (100 pts) | Weight |
|-----------|----------------------|-------------------|--------|
| npm       | downloads (30 d)     | 5,000,000         | 0.30   |
| crates.io | downloads (90 d)     | 20,000,000        | 0.10   |
| Docker Hub| pulls (total)        | 1,000,000,000     | 0.15   |
| GitHub    | stars                | 50,000            | 0.25   |
| Contracts | on-chain imports     | 300               | 0.20   |

The **impact score** is the weighted sum of the available sources' points, with
weights renormalized over the sources that have data. A repository with no data
scores `0`. The score is capped at `100`.

### Snapshot hashing

Every scorecard includes a `snapshotHash = keccak256` of the
[canonicalized](src/services/scoreEngine.ts) metrics (source, metric key, value,
sorted). The oracle signs `{ repoId, score, snapshotHash, timestamp }` with
EIP-712, so anyone can verify that a scorecard was produced by the backend.

## Badges and milestones

Derived in `src/services/badges.ts`. Badges are minted once per title (dedup by
`hasAttestation`); milestones are minted once per threshold crossed.

| Kind        | Key                 | Condition                                    |
|-------------|---------------------|----------------------------------------------|
| Badge       | `verified-impact`   | score ≥ 70                                   |
| Badge       | `high-adoption`     | best single-source points ≥ 85               |
| Badge       | `broad-usage`       | ≥ 3 sources with ≥ 40 points                 |
| Badge       | `on-chain-adopted`  | contracts metric ≥ 10 or `contractsCount` ≥ 10 |
| Milestone   | `npm-*`             | downloads ≥ 100k / 1M / 10M                  |
| Milestone   | `crates-*`          | downloads ≥ 100k / 1M / 10M                  |
| Milestone   | `github-*`          | stars ≥ 1k / 10k / 100k                      |
| Milestone   | `docker-*`          | pulls ≥ 10M / 100M                           |
| Milestone   | `contracts-*`       | imports ≥ 10 / 50 / 200                      |

Plus a `score` attestation (`impact-score`) that is (re)minted whenever the
score changes.

## Attestation lifecycle

1. The pipeline computes metrics, score, badges, and milestones for a repo.
2. The registry's `oracle` role is checked and the repo is registered on-chain if
   needed (`ensureRepositoryRegistered`).
3. Each item is attested via `attestImpactBadge` / `attestMilestone` /
   `attestScore` on the registry, which mints an EAS attestation.
4. The UID, tx hash, and block number are stored locally with status
   `confirmed`. On failure, a deterministic placeholder UID is stored with status
   `failed` and the error note (retried on the next pipeline run).

Every attestation carries a resolvable `metadataURI` served by the backend at
`GET /api/metadata/repositories/:repoId/:kind/:title.json`.

## REST API

All JSON. `GET` endpoints are public; admin endpoints require the
`X-API-Key` header.

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api` | API index / endpoint list |
| GET | `/api/health` | Health check (incl. chain readiness) |
| GET | `/api/chain/config` | Chain, registry, EAS, oracle, and schema info |
| GET | `/api/repositories` | Active repositories with live score + badges |
| GET | `/api/repositories/:id` | Single repository with score + badges |
| GET | `/api/repositories/:id/scorecard` | Full scorecard: breakdown, metrics, badges, milestones, oracle signature, on-chain status, attestations |
| GET | `/api/repositories/:id/attestations` | Local attestation log for a repo |
| GET | `/api/verify/:uid` | Read + verify an attestation from the chain |
| GET | `/api/drip-lists` | All drip lists |
| POST | `/api/drip-lists` | Create a drip list (splits must sum to 100) |
| GET | `/api/drip-lists/:id` | Drip list with enriched projects |
| POST | `/api/drip-lists/:id/attest` | Mint a drip list attestation on-chain |
| GET | `/api/metadata/repositories/:repoId/:kind/:title.json` | Attestation metadata (resolvable URI) |
| GET | `/api/metadata/drip-lists/:id.json` | Drip list manifest |

### Admin (require `X-API-Key: <ADMIN_API_KEY>`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/repositories` | Register a repository |
| PATCH | `/api/admin/repositories/:id` | Update repository fields / toggle `active` |
| DELETE | `/api/admin/repositories/:id` | Deactivate a repository |
| POST | `/api/admin/repositories/:id/refresh` | Run the pipeline for one repo |
| POST | `/api/admin/pipeline/run` | Run the pipeline for all active repos |

Example — register a repository:

```bash
curl -X POST http://localhost:8080/api/admin/repositories \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-admin-key" \
  -d '{
    "name": "viem",
    "repoUrl": "https://github.com/wevm/viem",
    "packageType": "npm",
    "packageName": "viem",
    "githubRepo": "wevm/viem",
    "contractsCount": 120
  }'
```

## Environment variables

Copy `.env.example` to `.env` and adjust. Everything has a dev default.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Base URL used in metadata URIs |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |
| `DATABASE_PATH` | `./data/impact.db` | SQLite file path (`:memory:` supported) |
| `RPC_URL` | `http://127.0.0.1:8545` | EVM RPC endpoint |
| `CHAIN_ID` | `31337` | Chain id |
| `REGISTRY_ADDRESS` | *(deployments file)* | Impact registry address |
| `EAS_ADDRESS` | *(deployments file)* | EAS address |
| `DEPLOYMENTS_FILE` | `../contracts/deployments/local.json` | Chain config JSON (from `npm run deploy`) |
| `EXPLORER_URL` | — | Explorer base URL for links |
| `ORACLE_PRIVATE_KEY` | Hardhat account #1 | Oracle EOA key (must match the registry `oracle` role) |
| `INGEST_ON_START` | `true` | Run the pipeline once on startup |
| `INGEST_INTERVAL_MS` | `21600000` | Pipeline cadence (ms) |
| `GITHUB_TOKEN` | — | GitHub API token (unauthenticated = 60 req/h) |
| `ADMIN_API_KEY` | `dev-admin-key` | Key for admin endpoints |

## Project layout

```
backend/
├── src/
│   ├── server.ts            # entrypoint: HTTP server + pipeline scheduler
│   ├── app.ts               # Express REST API
│   ├── config.ts            # env + chain/deployment config, schema UIDs
│   ├── db.ts                # SQLite schema + data access
│   ├── types.ts             # shared domain types
│   ├── lib/
│   │   └── abi.ts           # minimal viem ABIs (registry + EAS)
│   ├── pipeline/
│   │   └── sources.ts       # live metric fetchers (npm/crates/docker/gh/contracts)
│   ├── services/
│   │   ├── pipeline.ts      # ingestion orchestration + attestation dedup
│   │   ├── scoreEngine.ts   # scoring + canonical snapshot hashing
│   │   ├── badges.ts        # badge/milestone derivation
│   │   ├── attester.ts      # on-chain registry/EAS reads + writes
│   │   └── signer.ts        # EIP-712 oracle snapshot signing
│   └── scripts/
│       └── seed.ts          # seed example repos and run the pipeline
├── test/                    # vitest suites (API, pipeline, signer, …)
├── .env.example
├── vitest.config.ts
├── tsconfig.json / tsconfig.build.json
└── package.json
```

## Getting started

Prerequisites: Node.js ≥ 20.

```bash
# 1. dependencies
npm install

# 2. start a local chain (Hardhat node) + deploy the contracts
#    from the contracts/ folder:
npm --prefix ../contracts run node:background
npm --prefix ../contracts run deploy

# 3. configure the backend
cp .env.example .env
#    defaults already point at the local chain + deployments file

# 4. seed with real projects and run the pipeline once
npm run seed

# 5. run the API + scheduled pipeline
npm run dev
```

You can now open `http://localhost:8080/api` and, for example,
`http://localhost:8080/api/repositories/ethers/scorecard`.

> The `seed` and `dev` scripts mint attestations on the local chain via the
> oracle key from `.env`. If the chain is down, metrics are still indexed and
> failed attestations are retried on the next run.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run with hot reload (`tsx watch`) |
| `npm run start` | Run the built output (`node dist/server.js`) |
| `npm run build` | Compile to `dist/` |
| `npm run seed` | Seed example repositories and refresh metrics |
| `npm test` | Run the vitest suite |
| `npm run typecheck` | `tsc --noEmit` |

## Testing

```bash
npm test
npm run typecheck
```

The suite covers the REST API (including admin auth and the repository
lifecycle), the ingestion pipeline (scoring, badges, milestones, attestation
dedup), and EIP-712 snapshot signing. On-chain calls are mocked.
