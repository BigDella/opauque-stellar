/**
 * Generate witness determinism fixture hashes for v2 and v3 circuits.
 *
 * Run after building the circuit WASM:
 *   tsx circuits/scripts/generate-witness-hashes.ts
 *
 * Then paste the printed hashes into circuits/fixtures/witness-hashes.json
 * and commit together with any circuit change that alters witness output.
 *
 * Canonicalisation: witness = snarkjs.wtns.exportJson(wtnsPath) returns
 * BigInt[]; the hash input is JSON.stringify(witness.map(x => x.toString()));
 * algorithm is SHA-256, encoding is lowercase hex.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_ROOT = resolve(__dirname, "..");

const CIRCUIT_CONFIG = {
  v2: {
    wasmPath: join(CIRCUITS_ROOT, "v2/build/stealth_reputation_js/stealth_reputation.wasm"),
    fixturePath: join(CIRCUITS_ROOT, "fixtures/v2/valid-input.json"),
  },
  v3: {
    wasmPath: join(CIRCUITS_ROOT, "v3/build/privacy_pool_withdraw_js/privacy_pool_withdraw.wasm"),
    fixturePath: join(CIRCUITS_ROOT, "fixtures/v3/valid-input.json"),
  },
};

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

async function hashWitness(version) {
  const cfg = CIRCUIT_CONFIG[version];
  if (!existsSync(cfg.wasmPath)) {
    console.error(`SKIP ${version}: WASM not found at ${cfg.wasmPath} — compile first with npm run build`);
    return null;
  }
  const input = JSON.parse(readFileSync(cfg.fixturePath, "utf8"));
  const tmpDir = join(CIRCUITS_ROOT, "build", "hash-gen-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const wtnsPath = join(tmpDir, `${version}-hash.wtns`);
  await snarkjs.wtns.calculate(input, cfg.wasmPath, wtnsPath, QUIET);
  const witness = await snarkjs.wtns.exportJson(wtnsPath);
  const canonical = JSON.stringify(witness.map((x) => x.toString()));
  const hash = createHash("sha256").update(canonical).digest("hex");
  return { hash, signalCount: witness.length };
}

async function main() {
  console.log("Generating witness hashes for determinism fixtures...\n");
  const results = {};
  for (const version of ["v2", "v3"]) {
    const result = await hashWitness(version);
    if (result) {
      results[version] = result;
      console.log(`${version}: witnessHash = "${result.hash}"  (${result.signalCount} signals)`);
    }
  }

  console.log("\nPaste into circuits/fixtures/witness-hashes.json:");
  for (const [version, { hash }] of Object.entries(results)) {
    console.log(`  "${version}": { ..., "witnessHash": "${hash}" }`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
