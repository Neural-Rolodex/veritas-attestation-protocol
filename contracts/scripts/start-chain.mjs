#!/usr/bin/env node
/**
 * Starts a local Hardhat node in the background (if not already running) and
 * deploys the ImpactAttestationRegistry + EAS stack to it.
 *
 * Usage: npm run chain:start
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const RPC = "http://127.0.0.1:8545";
const LOG_FILE = join(root, "chain-node.log");

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  return res.json();
}

async function waitForNode(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await rpc("eth_chainId");
      if (res.result) return res.result;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Hardhat node did not become ready in time");
}

async function main() {
  let alreadyRunning = false;
  try {
    const res = await rpc("eth_chainId");
    alreadyRunning = Boolean(res.result);
  } catch {
    alreadyRunning = false;
  }

  if (!alreadyRunning) {
    console.log("Starting Hardhat node in background (logs -> contracts/chain-node.log) ...");
    const child = spawn("npx", ["hardhat", "node"], {
      cwd: root,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    await waitForNode();
    console.log("Hardhat node is up.");
  } else {
    console.log("Hardhat node already running.");
  }

  const chainId = await rpc("eth_chainId");
  console.log(`Chain ID: ${parseInt(chainId.result, 16)}`);

  const deploy = spawnSync("npx", ["hardhat", "run", "scripts/deploy.ts", "--network", "localhost"], {
    cwd: root,
    stdio: "inherit",
  });
  if (deploy.status !== 0) {
    console.error("Deployment failed.");
    process.exit(1);
  }
  console.log("\nDone. Chain + contracts are live on http://127.0.0.1:8545");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
