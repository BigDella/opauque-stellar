/**
 * Writes SHA-256 WASM hashes from stellar contract build output into the manifest.
 *
 * Usage: npx tsx scripts/update-manifest-wasm-hashes.ts --network testnet
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PACKAGE_TO_WASM = {
  "stealth-registry": "target/wasm32v1-none/release/stealth_registry.wasm",
  "stealth-announcer": "target/wasm32v1-none/release/stealth_announcer.wasm",
  "groth16-verifier": "target/wasm32v1-none/release/groth16_verifier.wasm",
  "reputation-verifier": "target/wasm32v1-none/release/reputation_verifier.wasm",
  "schema-registry": "target/wasm32v1-none/release/schema_registry.wasm",
  "attestation-engine-v2": "target/wasm32v1-none/release/attestation_engine_v2.wasm",
};

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const networkIdx = process.argv.indexOf("--network");
  const network = networkIdx >= 0 ? process.argv[networkIdx + 1] : null;
  if (!network || (network !== "testnet" && network !== "mainnet")) {
    console.error("Usage: node scripts/update-manifest-wasm-hashes.mjs --network <testnet|mainnet>");
    process.exit(1);
  }

  const manifestPath = join(ROOT, "deployments", "v1", `${network}.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  for (const [key, record] of Object.entries(manifest.contracts)) {
    const pkg = record.package;
    const rel = PACKAGE_TO_WASM[pkg];
    if (!rel) {
      console.warn(`No WASM mapping for ${key} (package ${pkg})`);
      continue;
    }
    const wasmPath = join(ROOT, rel);
    if (!existsSync(wasmPath)) {
      console.warn(`Skip ${key}: ${rel} not found`);
      continue;
    }
    record.wasmHash = sha256File(wasmPath);
    console.log(`${key}: ${record.wasmHash}`);
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated ${manifestPath}`);
}

main();
