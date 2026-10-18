/**
 * One-command Soroban deployment for Opaque Stellar.
 *
 * Builds the core contracts, deploys them to the target network, records the
 * resulting contract IDs / WASM hashes / ledger into the canonical manifest at
 * `deployments/v1/<network>.json`, and leaves it in a strict-verifiable state.
 *
 * Usage:
 *   npm run deploy:testnet
 *   npm run deploy:mainnet
 *   npx tsx scripts/deploy-contracts.ts --network testnet --dry-run
 *   npx tsx scripts/deploy-contracts.ts --network testnet --skip-build
 *
 * Configuration (via root `.env` — see `.env.example`):
 *   STELLAR_NETWORK           testnet | mainnet            (or --network <net>)
 *   STELLAR_DEPLOYER          stellar-cli identity name    (preferred)
 *   STELLAR_DEPLOYER_SECRET   raw secret seed (S...)       (alternative)
 *   STELLAR_DEPLOYER_ADDRESS  G... address for the record  (optional)
 *
 * Flags:
 *   --network <testnet|mainnet>   target network (default: $STELLAR_NETWORK or testnet)
 *   --dry-run                     build + plan only; do not deploy or write IDs
 *   --skip-build                  reuse existing target/ WASM (skip `stellar contract build`)
 *   --force                       bypass the mainnet audit-signoff gate (NOT recommended)
 *   --pool                        deploy only the privacy-pool add-on contracts
 *   --relayer                     deploy only the relayer-registry add-on contract
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Minimal, dependency-free loader for the root `.env` so `npm run deploy:*` works
 * with nothing but a populated `.env` file. Existing process env vars win, so CI
 * secrets and inline `STELLAR_NETWORK=… npm run deploy` overrides are respected.
 */
function loadDotEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

/**
 * Deploy order. All six are deployed before any initialize() runs, so the order
 * within this list is not load-bearing for wiring; it is kept dependency-first
 * (groth16-verifier before reputation-verifier, schema-registry before
 * attestation-engine-v2) so it reads naturally. None have constructors; two have
 * one-time initialize() calls run in the wiring phase below.
 */
const PACKAGES = [
  { key: "stealthRegistry", pkg: "stealth-registry", wasm: "stealth_registry" },
  { key: "stealthAnnouncer", pkg: "stealth-announcer", wasm: "stealth_announcer" },
  { key: "groth16Verifier", pkg: "groth16-verifier", wasm: "groth16_verifier" },
  { key: "reputationVerifier", pkg: "reputation-verifier", wasm: "reputation_verifier" },
  { key: "schemaRegistry", pkg: "schema-registry", wasm: "schema_registry" },
  { key: "attestationEngineV2", pkg: "attestation-engine-v2", wasm: "attestation_engine_v2" },
];

const STELLAR_CONTRACT_ID = /C[A-Z2-7]{55}/g;

// Domain separator for the privacy pool's deposit labels (Poseidon(scope, index)).
const POOL_SCOPE = 1;
const RELAYER_MINIMUM_STAKE = 1_000_000; // 0.1 XLM.
const RELAYER_UNSTAKE_COOLDOWN = 720; // ~1 hour at 5s ledgers.
const RELAYER_MAX_DEADLINE = 17_280; // ~1 day at 5s ledgers.

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
}

/** Invoke a deployed contract method via the stellar CLI; returns raw stdout. */
function invoke(contractId, source, network, methodArgs) {
  return sh("stellar", [
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source-account",
    source,
    "--network",
    network,
    "--",
    ...methodArgs,
  ]);
}

/** Parse the JSON return value the stellar CLI prints to stdout for a contract call. */
function parseInvokeResult(out) {
  const trimmed = out.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to the first JSON-looking span if the CLI emitted extra output.
    const start = trimmed.search(/[[{"]/);
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

async function latestLedger(rpcUrl) {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
    });
    const json = await res.json();
    return json?.result?.sequence ?? null;
  } catch {
    return null;
  }
}

/**
 * Incremental Phase 5 deploy: stand up a fresh v3-capable groth16-verifier instance
 * (`poolVerifier` — the original on-chain verifier predates verify_proof_v3) plus the
 * `privacy-pool`, initialize the pool, read back its wiring, and record both in the
 * manifest WITHOUT touching the existing six contracts. Triggered by `--pool`.
 */
async function deployPrivacyPool({ network, source, deployerAddress, manifest, manifestPath, dryRun }) {
  if (!deployerAddress) {
    fail("Deployer G-address required as pool admin; set STELLAR_DEPLOYER_ADDRESS or use a named identity.");
  }
  const admin = deployerAddress;

  // Native XLM Stellar Asset Contract id for this network.
  const nativeSac = sh("stellar", [
    "contract", "id", "asset", "--asset", "native", "--network", network,
  ]).trim();
  console.log(`• Native SAC: ${nativeSac}`);

  const deployOne = (pkg, wasm) => {
    const wasmPath = join(ROOT, "target", "wasm32v1-none", "release", `${wasm}.wasm`);
    if (!existsSync(wasmPath)) fail(`WASM not found: ${wasmPath} (run without --skip-build first).`);
    const wasmHash = sha256File(wasmPath);
    if (dryRun) {
      console.log(`• [dry-run] ${pkg}  wasmHash=${wasmHash}`);
      return { id: null, wasmHash };
    }
    console.log(`• Deploying ${pkg}…`);
    const out = sh("stellar", [
      "contract", "deploy", "--wasm", wasmPath, "--source-account", source, "--network", network,
    ]);
    const matches = out.match(STELLAR_CONTRACT_ID);
    const id = matches ? matches[matches.length - 1] : null;
    if (!id) fail(`Could not parse contract ID from deploy output:\n${out}`);
    console.log(`  ↳ ${id}`);
    return { id, wasmHash };
  };

  const verifier = deployOne("groth16-verifier", "groth16_verifier");
  const pool = deployOne("privacy-pool", "privacy_pool");

  if (dryRun) {
    console.log("\nDry run complete (pool). No contracts deployed, manifest not written.\n");
    return;
  }

  console.log("• Initializing privacy-pool…");
  invoke(pool.id, source, network, [
    "initialize",
    "--admin", admin,
    "--groth16_verifier", verifier.id,
    "--native_sac", nativeSac,
    "--scope", String(POOL_SCOPE),
  ]);

  console.log("• Verifying wiring (read-back)…");
  const cfg = parseInvokeResult(invoke(pool.id, source, network, ["get_config"]));
  if (!cfg || cfg.groth16_verifier !== verifier.id || cfg.native_sac !== nativeSac) {
    fail(
      `privacy-pool wiring mismatch: groth16=${cfg?.groth16_verifier ?? "<none>"} ` +
        `native_sac=${cfg?.native_sac ?? "<none>"}`,
    );
  }
  console.log(
    `  ↳ privacy-pool → groth16 ${cfg.groth16_verifier}, native SAC ${cfg.native_sac}, scope ${cfg.scope}`,
  );

  manifest.contracts.poolVerifier = {
    id: verifier.id,
    wasmHash: verifier.wasmHash,
    package: "groth16-verifier",
  };
  manifest.contracts.privacyPool = {
    id: pool.id,
    wasmHash: pool.wasmHash,
    package: "privacy-pool",
  };
  manifest.wiring ??= {};
  manifest.wiring.privacyPool = {
    admin,
    groth16Verifier: verifier.id,
    nativeSac,
    scope: POOL_SCOPE,
  };
  manifest.deployedAt = new Date().toISOString();
  manifest.deploymentLedger = await latestLedger(manifest.rpcUrl);

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n✓ Updated ${manifestPath} (poolVerifier + privacyPool)`);
  console.log(
    `\nNext: npm run verify:deployment:strict -- --network ${network} --check-wasm\n`,
  );
}

/**
 * Incremental Phase 6 deploy: stand up the relayer registry against the existing
 * native SAC + privacy-pool deployment without touching any prior contracts.
 */
async function deployRelayerRegistry({ network, source, deployerAddress, manifest, manifestPath, dryRun }) {
  if (!deployerAddress) {
    fail("Deployer G-address required as relayer registry admin; set STELLAR_DEPLOYER_ADDRESS or use a named identity.");
  }
  const admin = deployerAddress;
  const nativeSac = manifest.wiring?.privacyPool?.nativeSac ||
    sh("stellar", ["contract", "id", "asset", "--asset", "native", "--network", network]).trim();
  const privacyPool = manifest.contracts?.privacyPool?.id;
  if (!privacyPool) {
    fail("privacyPool must be deployed before relayerRegistry. Run deploy --pool first.");
  }

  const wasmPath = join(ROOT, "target", "wasm32v1-none", "release", "relayer_registry.wasm");
  if (!existsSync(wasmPath)) fail(`WASM not found: ${wasmPath} (run without --skip-build first).`);
  const wasmHash = sha256File(wasmPath);
  if (dryRun) {
    console.log(`• [dry-run] relayer-registry wasmHash=${wasmHash}`);
    return;
  }

  console.log("• Deploying relayer-registry…");
  const out = sh("stellar", [
    "contract", "deploy", "--wasm", wasmPath, "--source-account", source, "--network", network,
  ]);
  const matches = out.match(STELLAR_CONTRACT_ID);
  const id = matches ? matches[matches.length - 1] : null;
  if (!id) fail(`Could not parse contract ID from deploy output:\n${out}`);
  console.log(`  ↳ ${id}`);

  console.log("• Initializing relayer-registry…");
  invoke(id, source, network, [
    "initialize",
    "--admin", admin,
    "--native_sac", nativeSac,
    "--privacy_pool", privacyPool,
    "--minimum_stake", String(RELAYER_MINIMUM_STAKE),
    "--unstake_cooldown_ledgers", String(RELAYER_UNSTAKE_COOLDOWN),
    "--max_deadline_ledgers", String(RELAYER_MAX_DEADLINE),
  ]);

  console.log("• Verifying wiring (read-back)…");
  const cfg = parseInvokeResult(invoke(id, source, network, ["get_config"]));
  if (!cfg || cfg.native_sac !== nativeSac || cfg.privacy_pool !== privacyPool) {
    fail(
      `relayer-registry wiring mismatch: native_sac=${cfg?.native_sac ?? "<none>"} ` +
        `privacy_pool=${cfg?.privacy_pool ?? "<none>"}`,
    );
  }
  console.log(
    `  ↳ relayer-registry → pool ${cfg.privacy_pool}, native SAC ${cfg.native_sac}`,
  );

  manifest.contracts.relayerRegistry = {
    id,
    wasmHash,
    package: "relayer-registry",
  };
  manifest.wiring ??= {};
  manifest.wiring.relayerRegistry = {
    admin,
    nativeSac,
    privacyPool,
    minimumStake: RELAYER_MINIMUM_STAKE,
    unstakeCooldownLedgers: RELAYER_UNSTAKE_COOLDOWN,
    maxDeadlineLedgers: RELAYER_MAX_DEADLINE,
  };
  manifest.deployedAt = new Date().toISOString();
  manifest.deploymentLedger = await latestLedger(manifest.rpcUrl);

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n✓ Updated ${manifestPath} (relayerRegistry)`);
  console.log(
    `\nNext: npm run verify:deployment:strict -- --network ${network} --check-wasm\n`,
  );
}

async function main() {
  const network = arg("network", process.env.STELLAR_NETWORK || "testnet");
  const dryRun = flag("dry-run");
  const skipBuild = flag("skip-build");
  const force = flag("force");

  if (network !== "testnet" && network !== "mainnet") {
    fail(`Unsupported network "${network}". Use testnet or mainnet.`);
  }

  // Identity: prefer a configured stellar-cli identity name, fall back to a raw secret.
  const identity = process.env.STELLAR_DEPLOYER?.trim();
  const secret = process.env.STELLAR_DEPLOYER_SECRET?.trim();
  const source = identity || secret;
  if (!dryRun && !source) {
    fail(
      "No deployer configured. Set STELLAR_DEPLOYER (identity name) or " +
        "STELLAR_DEPLOYER_SECRET (S... seed) in your .env. See .env.example.",
    );
  }

  // Mainnet safety gate: require security-audit signoff unless explicitly forced.
  if (network === "mainnet" && !force) {
    try {
      sh("node", ["scripts/verify-security-audit.ts", "--network", "mainnet"], { stdio: "inherit" });
    } catch {
      fail(
        "Mainnet audit signoff check failed. Resolve blocking findings (see " +
          "deployments/security/mainnet-audit-findings.json) or pass --force to override.",
      );
    }
  }

  const manifestPath = join(ROOT, "deployments", "v1", `${network}.json`);
  if (!existsSync(manifestPath)) fail(`Missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  console.log(`\nOpaque Stellar deploy → ${network}${dryRun ? " (dry run)" : ""}\n`);

  if (!skipBuild) {
    console.log("• Building contracts (stellar contract build)…");
    sh("stellar", ["contract", "build"], { stdio: "inherit" });
  }

  // Resolve deployer G-address for the record (best effort).
  let deployerAddress = process.env.STELLAR_DEPLOYER_ADDRESS?.trim() || null;
  if (!deployerAddress && identity) {
    try {
      deployerAddress = sh("stellar", ["keys", "address", identity]).trim();
    } catch {
      /* leave null; record can be filled manually */
    }
  }

  // Incremental privacy-pool deploy (does not touch the existing six contracts).
  if (flag("pool")) {
    await deployPrivacyPool({ network, source, deployerAddress, manifest, manifestPath, dryRun });
    return;
  }
  if (flag("relayer")) {
    await deployRelayerRegistry({ network, source, deployerAddress, manifest, manifestPath, dryRun });
    return;
  }

  for (const { key, pkg, wasm } of PACKAGES) {
    const wasmPath = join(ROOT, "target", "wasm32v1-none", "release", `${wasm}.wasm`);
    if (!existsSync(wasmPath)) {
      fail(`WASM not found: ${wasmPath} (run without --skip-build first).`);
    }
    const wasmHash = sha256File(wasmPath);

    if (dryRun) {
      console.log(`• [dry-run] ${pkg}  wasmHash=${wasmHash}`);
      manifest.contracts[key].wasmHash = wasmHash;
      continue;
    }

    console.log(`• Deploying ${pkg}…`);
    const out = sh("stellar", [
      "contract",
      "deploy",
      "--wasm",
      wasmPath,
      "--source-account",
      source,
      "--network",
      network,
    ]);
    const matches = out.match(STELLAR_CONTRACT_ID);
    const id = matches ? matches[matches.length - 1] : null;
    if (!id) fail(`Could not parse contract ID from deploy output:\n${out}`);

    manifest.contracts[key].id = id;
    manifest.contracts[key].wasmHash = wasmHash;
    console.log(`  ↳ ${id}`);
  }

  if (dryRun) {
    console.log("\nDry run complete. No contracts deployed, manifest not written.\n");
    return;
  }

  // -------------------------------------------------------------------------
  // Post-deploy initialization + cross-contract wiring.
  // reputation-verifier and attestation-engine-v2 each require a one-time
  // initialize() before use; the other four have no constructor. Both wiring
  // calls depend on contracts already deployed above (groth16-verifier and
  // schema-registry), so they run only after the full deploy loop.
  // -------------------------------------------------------------------------
  if (!deployerAddress) {
    fail(
      "Deployer G-address could not be resolved; it is required as the admin for " +
        "initialize(). Set STELLAR_DEPLOYER_ADDRESS in .env or use a named identity.",
    );
  }

  const admin = deployerAddress;
  const groth16Id = manifest.contracts.groth16Verifier.id;
  const schemaRegistryId = manifest.contracts.schemaRegistry.id;
  const reputationId = manifest.contracts.reputationVerifier.id;
  const attestationId = manifest.contracts.attestationEngineV2.id;
  const ATTESTATION_CONFIG_VERSION = 1;

  console.log("\n• Initializing reputation-verifier…");
  invoke(reputationId, source, network, [
    "initialize",
    "--admin",
    admin,
    "--groth16_verifier",
    groth16Id,
  ]);

  console.log("• Initializing attestation-engine-v2…");
  invoke(attestationId, source, network, [
    "initialize",
    "--admin",
    admin,
    "--governance",
    admin,
    "--schema_registry",
    schemaRegistryId,
    "--version",
    String(ATTESTATION_CONFIG_VERSION),
  ]);

  // Read-back: confirm the wiring actually landed on-chain before we record it.
  console.log("• Verifying wiring (read-back)…");
  const repConfig = parseInvokeResult(invoke(reputationId, source, network, ["get_config"]));
  if (!repConfig || repConfig.groth16_verifier !== groth16Id) {
    fail(
      `reputation-verifier wiring mismatch: expected groth16_verifier=${groth16Id}, ` +
        `got ${repConfig?.groth16_verifier ?? "<none>"}`,
    );
  }
  const attConfig = parseInvokeResult(invoke(attestationId, source, network, ["get_config"]));
  if (!attConfig || attConfig.schema_registry !== schemaRegistryId) {
    fail(
      `attestation-engine-v2 wiring mismatch: expected schema_registry=${schemaRegistryId}, ` +
        `got ${attConfig?.schema_registry ?? "<none>"}`,
    );
  }
  console.log(`  ↳ reputation-verifier → groth16 ${repConfig.groth16_verifier}`);
  console.log(`  ↳ attestation-engine-v2 → schema-registry ${attConfig.schema_registry}`);

  manifest.wiring = {
    reputationVerifier: { admin, groth16Verifier: groth16Id },
    attestationEngineV2: {
      admin,
      governance: admin,
      schemaRegistry: schemaRegistryId,
      version: ATTESTATION_CONFIG_VERSION,
    },
  };

  manifest.deployedAt = new Date().toISOString();
  manifest.deploymentLedger = await latestLedger(manifest.rpcUrl);
  if (deployerAddress) {
    manifest.deployer = deployerAddress;
    if (manifest.admin == null) manifest.admin = deployerAddress;
  }
  manifest.deploymentStatus = "deployed";

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n✓ Updated ${manifestPath}`);

  console.log(
    [
      "\nDeployed + initialized all 6 contracts; wiring recorded in the manifest.",
      "Next steps:",
      `  1. Verify:  npm run verify:deployment:strict -- --network ${network} --check-wasm`,
      `  2. Point the frontend at the new IDs (they are read from the manifest automatically),`,
      `     or set VITE_${network.toUpperCase()}_*_CONTRACT overrides for local dev.`,
      "  3. Commit the updated manifest.",
      "",
    ].join("\n"),
  );
}

main().catch((err) => fail(err?.message ?? String(err)));
