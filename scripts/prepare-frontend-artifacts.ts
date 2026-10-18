/**
 * Prepare frontend runtime artifacts: build scanner WASM, fetch circuit assets, verify hashes.
 * Set SKIP_FRONTEND_PREBUILD=1 when CI already built/downloaded artifacts.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

if (process.env.SKIP_FRONTEND_PREBUILD === "1") {
  console.log("SKIP_FRONTEND_PREBUILD=1 — skipping prepare-frontend-artifacts");
  process.exit(0);
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n> ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    ...opts,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("Build scanner WASM", "tsx", ["scripts/build-scanner-wasm.ts"]);

// Best-effort fetch; build continues when release assets are not published yet.
const fetchResult = spawnSync("tsx", ["scripts/fetch-circuit-artifacts.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
if (fetchResult.status !== 0) {
  console.warn("Circuit artifact fetch skipped or incomplete (build locally or publish release assets).");
}

run("Verify scanner runtime artifacts", "tsx", [
  "scripts/verify-artifact-manifest.ts",
  "--scanner",
  "--strict",
]);

// Production proof flows need these public runtime artifacts. Fail before
// vite build if they are missing, otherwise the deployed SPA can serve
// index.html for a .wasm URL and crash at WebAssembly.compile().
run("Verify frontend circuit runtime artifacts", "tsx", [
  "scripts/verify-artifact-manifest.ts",
  "--frontend-circuits",
  "--strict",
  "--vk-binding",
]);
