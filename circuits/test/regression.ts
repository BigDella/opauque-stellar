/**
 * Circuit regression tests with deterministic fixtures.
 *
 * Modes:
 *   default / --full   prove + verify with pinned zkey/wasm (requires release artifacts)
 *   --compile          compile circuits first (requires circom on PATH)
 *   --witness-only     calculate witness and compare public outputs (no zkey);
 *                      prefers build wasm/R1CS so constraint checks use a matched pair
 *
 * Usage:
 *   npx tsx circuits/test/regression.ts
 *   npx tsx circuits/test/regression.ts --version v1
 *   npx tsx circuits/test/regression.ts --compile --witness-only
 *
 * Extended checks (all run automatically when artifacts are present):
 *   - Constraint count regression: reads R1CS and compares nConstraints against
 *     circuits/fixtures/constraint-counts.json; fails on unexplained growth.
 *   - Negative proof vectors: each circuits/fixtures/<v>/negative/*.json must be
 *     rejected by the circuit (constraint violation, is_valid=0, or expected signal change).
 *   - Witness determinism: SHA-256 of the canonical witness JSON is compared against
 *     circuits/fixtures/witness-hashes.json; first differing signal index is reported
 *     on divergence.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(CIRCUITS_ROOT, "..");
const MANIFEST_PATH = join(REPO_ROOT, "artifacts", "manifest.json");
const CONSTRAINT_COUNTS_PATH = join(CIRCUITS_ROOT, "fixtures", "constraint-counts.json");
const WITNESS_HASHES_PATH = join(CIRCUITS_ROOT, "fixtures", "witness-hashes.json");
const QUIET_SNARKJS_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function parseArgs(argv) {
  const opts = {
    // V2 (reputation) is canonical and V3 (privacy pool) ships alongside it; both run by
    // default. V1 is retired (still runnable via --version v1).
    versions: ["v2", "v3"],
    compile: false,
    witnessOnly: false,
    full: true,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--version" && argv[i + 1]) opts.versions = [argv[++i]];
    else if (argv[i] === "--compile") opts.compile = true;
    else if (argv[i] === "--witness-only") {
      opts.witnessOnly = true;
      opts.full = false;
    } else if (argv[i] === "--full") opts.full = true;
  }
  return opts;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadManifest() {
  return loadJson(MANIFEST_PATH);
}

const CIRCUIT_CONFIG = {
  v1: {
    compileCwd: CIRCUITS_ROOT,
    compileCmd: ["npm", "run", "build"],
    buildWasm: join(CIRCUITS_ROOT, "build/stealth_attestation_js/stealth_attestation.wasm"),
    buildR1cs: join(CIRCUITS_ROOT, "build/stealth_attestation.r1cs"),
    buildVk: join(CIRCUITS_ROOT, "build/verification_key.json"),
    // V1 uses soft constraints: the circuit always satisfies R1CS but outputs is_valid=0
    // for invalid statements (no hard `===` assertions on root/attestation).
    softConstraints: true,
    publicSignalOrder: [
      "nullifier",
      "is_valid",
      "merkle_root",
      "attestation_id",
      "external_nullifier",
    ],
  },
  v2: {
    compileCwd: join(CIRCUITS_ROOT, "v2"),
    compileCmd: ["npm", "run", "build"],
    buildWasm: join(CIRCUITS_ROOT, "v2/build/stealth_reputation_js/stealth_reputation.wasm"),
    buildR1cs: join(CIRCUITS_ROOT, "v2/build/stealth_reputation.r1cs"),
    buildVk: join(CIRCUITS_ROOT, "v2/build/verification_key.json"),
    softConstraints: false,
    publicSignalOrder: [
      "merkle_root",
      "attestation_id",
      "external_nullifier",
      "nullifier_hash",
    ],
  },
  v3: {
    compileCwd: join(CIRCUITS_ROOT, "v3"),
    compileCmd: ["npm", "run", "build"],
    buildWasm: join(CIRCUITS_ROOT, "v3/build/privacy_pool_withdraw_js/privacy_pool_withdraw.wasm"),
    buildR1cs: join(CIRCUITS_ROOT, "v3/build/privacy_pool_withdraw.r1cs"),
    buildVk: join(CIRCUITS_ROOT, "v3/build/verification_key.json"),
    softConstraints: false,
    publicSignalOrder: [
      "withdrawnValue",
      "stateRoot",
      "aspRoot",
      "nullifierHash",
      "newCommitment",
      "context",
    ],
  },
};

function resolvePaths(version, manifest, opts = {}) {
  const circuit = manifest.circuits[version];
  const cfg = CIRCUIT_CONFIG[version];
  const frontendWasmPath = resolve(REPO_ROOT, circuit.frontend.witnessWasm.path);
  const hasBuildWitnessPair = existsSync(cfg.buildWasm) && existsSync(cfg.buildR1cs);
  const useBuildWasm = opts.witnessOnly && hasBuildWitnessPair;
  const wasmPath = useBuildWasm || !existsSync(frontendWasmPath) ? cfg.buildWasm : frontendWasmPath;
  const zkeyPath = existsSync(resolve(REPO_ROOT, circuit.frontend.zkey.path))
    ? resolve(REPO_ROOT, circuit.frontend.zkey.path)
    : null;
  const vkPath = existsSync(cfg.buildVk)
    ? cfg.buildVk
    : version === "v2"
      ? resolve(REPO_ROOT, circuit.contractVk.referenceVerificationKey.path)
      : null;
  const r1csPath = cfg.buildR1cs;
  return { wasmPath, zkeyPath, vkPath, r1csPath, cfg };
}

function runCompile(version) {
  const cfg = CIRCUIT_CONFIG[version];
  console.log(`Compiling ${version}...`);
  const [cmd, ...args] = cfg.compileCmd;
  const result = spawnSync(cmd, args, { cwd: cfg.compileCwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${version} compile failed (is circom installed?)`);
  }
}

function publicSignalsToMap(order, signals) {
  const map = {};
  order.forEach((name, i) => {
    map[name] = signals[i]?.toString?.() ?? String(signals[i]);
  });
  return map;
}

function assertPublicOutputs(version, signals, expected) {
  const order = CIRCUIT_CONFIG[version].publicSignalOrder;
  const actual = publicSignalsToMap(order, signals);
  const errors = [];
  for (const key of order) {
    if (actual[key] !== expected[key]) {
      errors.push(`${version}.${key}: expected ${expected[key]}, got ${actual[key]}`);
    }
  }
  return errors;
}

// =============================================================================
// Issue: Constraint count regression tracking
// Reads the compiled R1CS (when present) and compares nConstraints against the
// committed baseline in fixtures/constraint-counts.json. Fails on any deviation.
// To update: recompile the circuit and set the new nConstraints value in the
// baseline file in the same commit as the circuit change.
// =============================================================================
async function checkConstraintCount(version, r1csPath) {
  if (!existsSync(r1csPath)) return; // R1CS not built locally; skip
  if (!existsSync(CONSTRAINT_COUNTS_PATH)) {
    console.warn(`WARN: ${version}: constraint-counts.json not found; skipping constraint regression`);
    return;
  }
  const baseline = loadJson(CONSTRAINT_COUNTS_PATH);
  const entry = baseline[version];
  if (!entry || entry.nConstraints == null) {
    console.warn(`WARN: ${version}: no constraint baseline set; skipping (update constraint-counts.json after compilation)`);
    return;
  }
  const info = await snarkjs.r1cs.info(r1csPath, QUIET_SNARKJS_LOGGER);
  const actual = info.nConstraints;
  const expected = entry.nConstraints;
  if (actual !== expected) {
    throw new Error(
      `${version}: constraint count regression: expected ${expected}, got ${actual}. ` +
      `If this change is intentional, update circuits/fixtures/constraint-counts.json ` +
      `in the same commit as the circuit change.`
    );
  }
  console.log(`OK: ${version} constraint count ${actual} matches baseline`);
}

// =============================================================================
// Issue: Negative proof test vectors
// Each fixtures/<version>/negative/*.json is a deterministic negative vector.
// Every vector must include a "_expect" field:
//   "constraint_violation" — witness generation or R1CS check must fail
//   "is_valid_zero"        — witness generates but is_valid signal must be "0"
//   "nullifier_changed"    — witness generates but nullifier output must differ
//                            from the expected-public.json for the same version
// Fields prefixed with "_" are stripped before passing inputs to snarkjs.
// =============================================================================
async function testNegativeVectors(version, paths, fixtureDir) {
  const negativeDir = join(fixtureDir, "negative");
  if (!existsSync(negativeDir)) return;

  const files = readdirSync(negativeDir)
    .filter((f) => f.endsWith(".json"))
    .sort(); // deterministic order

  if (files.length === 0) return;

  const tmpDir = join(CIRCUITS_ROOT, "build", "test-tmp");
  mkdirSync(tmpDir, { recursive: true });

  if (!existsSync(paths.wasmPath)) {
    console.warn(`WARN: ${version}: WASM missing; skipping negative vector tests`);
    return;
  }

  const expectedPublicPath = join(fixtureDir, "expected-public.json");
  const expectedPublic = existsSync(expectedPublicPath) ? loadJson(expectedPublicPath) : null;

  for (const file of files) {
    const vectorPath = join(negativeDir, file);
    const raw = loadJson(vectorPath);
    const name = file.replace(".json", "");
    const expect = raw._expect ?? "constraint_violation";

    // Strip "_"-prefixed metadata fields before passing to snarkjs
    const input = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_")));

    const wtnsPath = join(tmpDir, `${version}-neg-${name}.wtns`);

    let witnessGenerated = false;
    try {
      await snarkjs.wtns.calculate(input, paths.wasmPath, wtnsPath, QUIET_SNARKJS_LOGGER);
      witnessGenerated = true;
    } catch (err) {
      // Witness generation failed — acceptable for "constraint_violation"
      if (expect === "constraint_violation") {
        console.log(`OK: ${version} neg '${name}': witness generation rejected (${String(err.message).slice(0, 80)})`);
        continue;
      }
      throw new Error(`${version} neg '${name}': unexpected witness generation failure: ${err.message}`);
    }

    // Witness generated — now check R1CS if available
    if (witnessGenerated && existsSync(paths.r1csPath)) {
      const ok = await snarkjs.wtns.check(paths.r1csPath, wtnsPath, QUIET_SNARKJS_LOGGER);
      if (!ok) {
        if (expect === "constraint_violation") {
          console.log(`OK: ${version} neg '${name}': R1CS constraint violated`);
          continue;
        }
        throw new Error(`${version} neg '${name}': unexpected R1CS constraint failure for expect="${expect}"`);
      }
      if (expect === "constraint_violation") {
        throw new Error(
          `${version} neg '${name}': expected constraint violation but witness satisfied R1CS. ` +
          `Suite fails if any negative vector satisfies the circuit.`
        );
      }
    }

    // Witness satisfied constraints (or no R1CS to check) — inspect signals
    const witness = await snarkjs.wtns.exportJson(wtnsPath);
    const publicSignals = witness.slice(1, 1 + paths.cfg.publicSignalOrder.length);
    const signals = publicSignalsToMap(paths.cfg.publicSignalOrder, publicSignals);

    if (expect === "is_valid_zero") {
      if (signals.is_valid !== "0") {
        throw new Error(
          `${version} neg '${name}': expected is_valid=0 but got is_valid=${signals.is_valid}. ` +
          `Suite fails if any negative vector satisfies the circuit.`
        );
      }
      console.log(`OK: ${version} neg '${name}': is_valid correctly = 0`);
    } else if (expect === "nullifier_changed") {
      const expectedNullifier = expectedPublic?.nullifier ?? expectedPublic?.nullifier_hash;
      const actualNullifier = signals.nullifier ?? signals.nullifier_hash;
      if (expectedNullifier != null && actualNullifier === expectedNullifier) {
        throw new Error(
          `${version} neg '${name}': expected nullifier to change but output matches expected-public.json. ` +
          `The external_nullifier must produce a distinct nullifier for each action.`
        );
      }
      console.log(`OK: ${version} neg '${name}': nullifier correctly differs from expected`);
    } else if (expect === "constraint_violation" && !existsSync(paths.r1csPath)) {
      // No R1CS; can only rely on WASM assertion — already survived witness generation
      console.warn(
        `WARN: ${version} neg '${name}': witness generated without error and no R1CS available ` +
        `to verify constraint violation. Build the circuit to enable full negative-vector checking.`
      );
    }
  }
}

// =============================================================================
// Issue: Cross-platform witness determinism test
// Computes SHA-256 of canonical witness JSON for fixed valid inputs and compares
// against the committed hash in fixtures/witness-hashes.json.
// On mismatch, finds and reports the first differing signal index.
// =============================================================================
async function checkWitnessDeterminism(version, paths, fixtureDir) {
  if (!existsSync(WITNESS_HASHES_PATH)) return;
  const hashes = loadJson(WITNESS_HASHES_PATH);
  const entry = hashes[version];
  if (!entry || entry.witnessHash === "PENDING" || !entry.witnessHash) {
    console.log(
      `SKIP: ${version} witness hash fixture not yet generated. ` +
      `Run: tsx circuits/scripts/generate-witness-hashes.ts`
    );
    return;
  }
  if (!existsSync(paths.wasmPath)) {
    console.warn(`WARN: ${version}: WASM missing; skipping witness determinism check`);
    return;
  }

  const input = loadJson(join(fixtureDir, "valid-input.json"));
  const tmpDir = join(CIRCUITS_ROOT, "build", "test-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const wtnsPath = join(tmpDir, `${version}-determinism.wtns`);
  await snarkjs.wtns.calculate(input, paths.wasmPath, wtnsPath, QUIET_SNARKJS_LOGGER);
  const witness = await snarkjs.wtns.exportJson(wtnsPath);

  const canonical = JSON.stringify(witness.map((x) => x.toString()));
  const hash = createHash("sha256").update(canonical).digest("hex");

  if (hash !== entry.witnessHash) {
    // Find first differing signal to aid debugging
    let firstDiff = null;
    if (entry.witnessSignals) {
      const committed = entry.witnessSignals;
      const current = witness.map((x) => x.toString());
      for (let i = 0; i < Math.min(committed.length, current.length); i++) {
        if (committed[i] !== current[i]) {
          firstDiff = `signal[${i}]: committed=${committed[i]}, current=${current[i]}`;
          break;
        }
      }
      if (firstDiff === null && committed.length !== current.length) {
        firstDiff = `signal count differs: committed=${committed.length}, current=${current.length}`;
      }
    }
    const detail = firstDiff ? ` First divergence: ${firstDiff}` : "";
    throw new Error(
      `${version}: witness determinism failure: hash mismatch on ${process.platform}. ` +
      `Expected ${entry.witnessHash}, got ${hash}.${detail} ` +
      `If the circuit WASM was rebuilt, regenerate with: tsx circuits/scripts/generate-witness-hashes.ts`
    );
  }
  console.log(`OK: ${version} witness hash matches fixture (${witness.length} signals, platform=${process.platform})`);
}

async function testValidCase(version, paths, fixtureDir) {
  const input = loadJson(join(fixtureDir, "valid-input.json"));
  const expected = loadJson(join(fixtureDir, "expected-public.json"));

  if (!existsSync(paths.wasmPath)) {
    throw new Error(`${version}: witness wasm missing at ${paths.wasmPath}`);
  }

  if (paths.witnessOnly ?? false) {
    const tmpDir = join(CIRCUITS_ROOT, "build", "test-tmp");
    mkdirSync(tmpDir, { recursive: true });
    const wtnsPath = join(tmpDir, `${version}-valid.wtns`);
    await snarkjs.wtns.calculate(input, paths.wasmPath, wtnsPath);

    if (existsSync(paths.r1csPath)) {
      const ok = await snarkjs.wtns.check(paths.r1csPath, wtnsPath, QUIET_SNARKJS_LOGGER);
      if (!ok) throw new Error(`${version}: valid witness failed r1cs check`);
    }

    const witness = await snarkjs.wtns.exportJson(wtnsPath);
    const publicSignals = witness.slice(1, 1 + paths.cfg.publicSignalOrder.length);
    const errors = assertPublicOutputs(version, publicSignals, expected);
    if (errors.length) throw new Error(errors.join("; "));
    console.log(`OK: ${version} valid witness`);
    return;
  }

  if (!paths.zkeyPath) {
    throw new Error(`${version}: zkey missing (fetch circuit artifacts or run trusted setup)`);
  }

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    paths.wasmPath,
    paths.zkeyPath,
  );
  const errors = assertPublicOutputs(version, publicSignals, expected);
  if (errors.length) throw new Error(errors.join("; "));

  if (paths.vkPath && existsSync(paths.vkPath)) {
    const vk = loadJson(paths.vkPath);
    const verified = await snarkjs.groth16.verify(vk, publicSignals, proof);
    if (!verified) throw new Error(`${version}: proof verification failed`);
  }

  console.log(`OK: ${version} valid prove + verify`);
}

async function testInvalidCase(version, paths, fixtureDir) {
  const input = loadJson(join(fixtureDir, "invalid-input.json"));

  if (paths.witnessOnly ?? false) {
    try {
      const tmpDir = join(CIRCUITS_ROOT, "build", "test-tmp");
      mkdirSync(tmpDir, { recursive: true });
      const wtnsPath = join(tmpDir, `${version}-invalid.wtns`);
      await snarkjs.wtns.calculate(input, paths.wasmPath, wtnsPath);
      if (existsSync(paths.r1csPath)) {
        const ok = await snarkjs.wtns.check(paths.r1csPath, wtnsPath, QUIET_SNARKJS_LOGGER);
        if (ok) {
          throw new Error(`${version}: invalid input unexpectedly satisfied constraints`);
        }
      }
      console.log(`OK: ${version} invalid witness rejected`);
      return;
    } catch (err) {
      if (String(err.message).includes("unexpectedly satisfied")) throw err;
      console.log(`OK: ${version} invalid witness rejected (${err.message})`);
      return;
    }
  }

  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      paths.wasmPath,
      paths.zkeyPath,
    );
    if (paths.vkPath && existsSync(paths.vkPath)) {
      const vk = loadJson(paths.vkPath);
      const verified = await snarkjs.groth16.verify(vk, publicSignals, proof);
      if (verified) {
        throw new Error(`${version}: invalid input produced verifying proof`);
      }
    }
    const expected = loadJson(join(fixtureDir, "expected-public.json"));
    const order = CIRCUIT_CONFIG[version].publicSignalOrder;
    const actual = publicSignalsToMap(order, publicSignals);
    if (actual.is_valid === "1") {
      throw new Error(`${version}: invalid input produced is_valid=1`);
    }
    console.log(`OK: ${version} invalid input did not produce valid attestation`);
  } catch (err) {
    if (String(err.message).includes("produced verifying proof")) throw err;
    console.log(`OK: ${version} invalid input rejected (${err.message?.slice?.(0, 80) ?? err})`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const manifest = loadManifest();
  const failures = [];

  for (const version of opts.versions) {
    try {
      if (opts.compile) runCompile(version);
      const paths = resolvePaths(version, manifest, opts);
      paths.witnessOnly = opts.witnessOnly;
      const fixtureDir = join(CIRCUITS_ROOT, "fixtures", version);

      // Constraint count regression (runs when R1CS is present)
      await checkConstraintCount(version, paths.r1csPath);

      // Valid-case regression
      await testValidCase(version, paths, fixtureDir);

      // Legacy invalid-case (single vector per fixture dir)
      await testInvalidCase(version, paths, fixtureDir);

      // Negative proof vectors (deterministic per-public-input fixtures)
      await testNegativeVectors(version, paths, fixtureDir);

      // Cross-platform witness determinism
      await checkWitnessDeterminism(version, paths, fixtureDir);
    } catch (err) {
      failures.push(`${version}: ${err.message}`);
    }
  }

  if (failures.length) {
    console.error("\nCircuit regression failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("\nOK: circuit regression tests passed");
  process.exit(0);
}

main();
