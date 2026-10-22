# Veritas Attestation Protocol — Smart Contracts

The on-chain half of the Veritas Attestation Protocol. A Solidity contract
(`ImpactAttestationRegistry`) integrates with the
[Ethereum Attestation Service (EAS)](https://attest.org/) to mint and track
verifiable attestations for open-source project impact: **impact badges**,
**milestones**, and **drip list** attestations.

The backend oracle (see `../backend`) is the privileged `oracle` role: it
registers repositories and triggers attestations; the registry mints them
through EAS and keeps a queryable, per-repository log of every attestation UID.

Built with Solidity 0.8.24 and Hardhat.

## Table of contents

- [How it works](#how-it-works)
- [Repository role model](#repository-role-model)
- [Attestation schemas](#attestation-schemas)
- [Contract surface](#contract-surface)
- [Deployment topology](#deployment-topology)
- [Project layout](#project-layout)
- [Getting started](#getting-started)
- [Scripts](#scripts)
- [Testing](#testing)

## How it works

```
 backend oracle ──RPC──▶ ImpactAttestationRegistry ──mint──▶ EAS
 (signs txs)           (owner / oracle roles)              (on-chain
                                                          attestation log)
                             │
                             └──▶ per-repo UID log (queryable on-chain)
```

1. The owner deploys the registry with the EAS and SchemaRegistry addresses and
   three attestation schema strings. The registry registers those schemas with
   EAS's SchemaRegistry at construction time.
2. The owner grants the `oracle` role to the backend's EOA.
3. The oracle registers a repository (`registerRepository`), producing a
   `bytes32` repo id (`keccak256(repoUrl)`).
4. For every score/badge/milestone, the oracle calls
   `attestImpactBadge` / `attestMilestone` / `attestScore` (score is minted via
   `attestImpactBadge` with badge `impact-score`). The registry mints an EAS
   attestation and records the UID against the repository.
5. Anyone can call the `repository`, `repositoryAttestations`,
   `attestationRecord`, `verifyAttestation`, and `getAttestation` views to read
   and verify the impact log.

Attestation recipients are the repository's registered owner when set,
otherwise the oracle (msg.sender).

## Repository role model

| Role | Capabilities |
|------|--------------|
| `owner` (deployer, Ownable) | `setOracle` |
| `oracle` | `registerRepository`, `updateRepository`, `setRepositoryActive`, `attestImpactBadge`, `attestMilestone`, `attestDripList`, `revokeImpactAttestation` |
| anyone | read-only views (`repository`, `repositoryAttestations`, `attestationRecord`, `getAttestation`, `verifyAttestation`, `getRepoId`, `repositoryCount`, `repositoryIds`) |

## Attestation schemas

The schemas are registered with EAS's SchemaRegistry during construction
(`revocable = true`). Their UIDs are deterministic
(`keccak256(abi.encodePacked(schema, resolver, revocable))`) and are recomputed
by the backend.

| Kind | Schema | Data encoded |
|------|--------|--------------|
| Impact badge | `string repoUrl,string badge,uint256 score,string metadataURI` | `abi.encode(repoUrl, badge, score, metadataURI)` |
| Milestone | `string repoUrl,string milestone,uint256 value,string metadataURI` | `abi.encode(repoUrl, milestone, value, metadataURI)` |
| Drip list | `string metadataURI` | `abi.encode(metadataURI)` |

`metadataURI` points at a resolvable JSON document served by the backend
(e.g. `GET /api/metadata/repositories/ethers/badge/verified-impact.json`).

## Contract surface

### `ImpactAttestationRegistry` (contracts/ImpactAttestationRegistry.sol)

State / getters:

- `oracle()` — the address allowed to register + attest (set via `setOracle`).
- `repository(bytes32 id)` — full repository record (id, repoUrl, name,
  packageType, owner, metadataURI, active, registeredAt).
- `repositoryCount()`, `repositoryIds()` — repository enumeration.
- `repositoryAttestations(bytes32 repoId)` — attestation UIDs for a repo.
- `attestationRecord(bytes32 uid)` — kind/value/timestamp for a minted UID.
- `getAttestation(bytes32 uid)` — reads an attestation directly from EAS.
- `verifyAttestation(bytes32 uid)` — true if the UID exists on EAS and is not revoked.
- `getRepoId(string repoUrl)` — `keccak256(repoUrl)` (pure).

Oracle-only writes:

- `registerRepository(repoUrl, name, packageType, owner, metadataURI)`
- `updateRepository(repoId, name, packageType, owner, metadataURI)`
- `setRepositoryActive(repoId, active)`
- `attestImpactBadge(repoUrl, badge, score, metadataURI)` → UID
- `attestMilestone(repoUrl, milestone, value, metadataURI)` → UID
- `attestDripList(metadataURI)` → UID
- `revokeImpactAttestation(repoId, uid)`

Owner-only write:

- `setOracle(address)`

Events:

- `RepositoryRegistered(repoId, repoUrl, name)`
- `RepositoryUpdated(repoId, repoUrl, name, active)`
- `ImpactAttestationCreated(repoId, uid, attestationType, value)`
- `DripListAttested(uid, attester, metadataURI)`
- `OracleChanged(address)`

The interfaces in `contracts/eas/` mirror the upstream EAS contracts
(`IEAS`, `ISchemaRegistry`) so only the minimal surface is imported.

## Deployment topology

```
┌─────────────────────────────────────────────────────────────┐
│  contracts/                                                 │
│   deploy.ts                                                  │
│    1. deploy EAS SchemaRegistry (upstream artifact)          │
│    2. deploy EAS               (upstream artifact)           │
│    3. deploy ImpactAttestationRegistry                       │
│    4. setOracle(account #1)   ← backend oracle               │
│    5. write deployments/<network>.json (+ local.json alias)  │
└─────────────────────────────────────────────────────────────┘
```

The backend reads `contracts/deployments/local.json` (via `DEPLOYMENTS_FILE`)
for chain config. `deployments/local.json` is git-ignored; other network files
are committed as reference deployment records.

## Project layout

```
contracts/
├── contracts/
│   ├── ImpactAttestationRegistry.sol   # main registry (badges, milestones, drips)
│   └── eas/
│       ├── IEAS.sol                    # minimal EAS interface
│       └── ISchemaRegistry.sol         # minimal schema registry interface
├── scripts/
│   ├── deploy.ts                       # full local deployment + oracle setup
│   └── start-chain.mjs                 # background Hardhat node helper
├── test/
│   └── registry.test.ts                # Hardhat test suite
├── deployments/                        # deployment configs written by deploy.ts
├── artifacts/  cache/  typechain-types/ # build outputs (git-ignored)
├── hardhat.config.ts
└── package.json
```

## Getting started

Prerequisites: Node.js ≥ 20.

```bash
# 1. dependencies
npm install

# 2. start a local chain (Hardhat node)
npm run node
#    or, to run it in the background: npm run node:background

# 3. in a second terminal, deploy the stack to it
npm run deploy
#    writes contracts/deployments/local.json used by the backend
```

The default Hardhat accounts are deterministic:
`account[0]` is the deployer (registry `owner`), `account[1]` is granted the
`oracle` role. The backend's `.env` default oracle key corresponds to
`account[1]`.

To compile or deploy on a different network, update `networks` in
`hardhat.config.ts` and run `npm run deploy -- --network <name>`. The deploy
script writes `deployments/<name>.json`.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run compile` | Compile the contracts (`hardhat compile`) |
| `npm run node` | Start a local Hardhat node (foreground) |
| `npm run node:background` | Start the local node in the background |
| `npm run deploy` | Deploy EAS + registry to `localhost` and write `deployments/local.json` |
| `npm run deploy:inmem` | Deploy to the in-memory `hardhat` network |
| `npm test` | Run the Hardhat test suite |
| `npm run typecheck` | `tsc --noEmit` (scripts + tests) |

## Testing

```bash
npm test
```

The suite deploys a fresh stack per fixture and covers:

- deployment wiring and schema UIDs
- oracle authorization (only the oracle can register/attest)
- repository registration, update, and deactivation
- badge, milestone, and drip list attestations (correct schemas + records)
- verification of unknown vs. valid attestations
- revocation semantics and authorization

> Note: `npm run typecheck` checks the Hardhat scripts and test files. The tests
> themselves use `ethers` contract typings and are exercised via `npm test`.
