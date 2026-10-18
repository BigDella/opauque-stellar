/**
 * Deploys `multisig-admin` and transfers protocol admin on the four
 * single-key-admin registries to it (#771).
 *
 * `contracts/multisig-admin` (the on-chain N-of-M threshold mechanism) and
 * every registry's `transfer_admin`/`transfer_governance` entrypoint already
 * exist and are tested end-to-end — see docs/MULTISIG_ADMIN.md. What has
 * never happened is actually RUNNING this migration against a live
 * deployment: `deployments/v1/testnet.json`'s `multisig` field is still
 * `null`, and every registry's `admin` is still the single deployer key
 * (`GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU` on testnet as
 * of this writing).
 *
 * WHY THIS IS A SCRIPT, NOT AN AUTOMATED ACTION: this call transfers
 * irreversible protocol admin control over already-deployed, live testnet
 * contracts. It requires the REAL deployer secret key (whoever controls
 * that key today) and the REAL public keys of every proposed multisig
 * signer — both of which only a human operator has, and which
 * automation must never be handed or asked to generate/guess. This script
 * does the mechanical work (deploy, initialize, transfer_admin x4) once a
 * human supplies those inputs; it does not decide who the signers should
 * be or run itself.
 *
 * Usage:
 *   node scripts/migrate-to-multisig-admin.ts --network testnet --dry-run \
 *     --signers G...,G...,G... --threshold 2
 *
 *   node scripts/migrate-to-multisig-admin.ts --network testnet \
 *     --signers G...,G...,G... --threshold 2
 *
 * Configuration (root `.env`, same convention as scripts/deploy-contracts.ts):
 *   STELLAR_NETWORK           testnet | mainnet            (or --network <net>)
 *   STELLAR_DEPLOYER          stellar-cli identity name    (preferred)
 *   STELLAR_DEPLOYER_SECRET   raw secret seed (S...)       (alternative)
 *
 * Flags:
 *   --network <testnet|mainnet>   target network (default: $STELLAR_NETWORK or testnet)
 *   --signers <G...,G...,...>     comma-separated signer G-addresses (>= 2, required)
 *   --threshold <N>               approval threshold (>= 2, required)
 *   --dry-run                     print every planned call; deploy/invoke nothing
 *   --skip-build                  reuse existing target/ WASM for multisig-admin
 *   --only <registry>             migrate a single registry (repeatable) instead of all four:
 *                                 privacyPool | reputationVerifier | relayerRegistry | attestationEngineV2
 *
 * See docs/MULTISIG_ADMIN.md for the mechanism this wires up, and
 * docs/MULTISIG_MIGRATION_RUNBOOK.md for the operator checklist (signer
 * selection, pre-flight verification, rollback considerations) this script
 * is one step of.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnv();

function flag(name) {
  return process.argv.includes(`--${name}`);
}
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function multiArg(name) {
  const out = [];
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) out.push(args[i + 1]);
  }
  return out;
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

function parseInvokeResult(out) {
  const trimmed = out.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
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

const G_ADDRESS = /^G[A-Z2-7]{55}$/;

/**
 * The four registries with a genuine single-key protocol admin — see
 * docs/MULTISIG_ADMIN.md "Scope" for why schema-registry/stealth-registry/
 * stealth-announcer are excluded.
 */
// `callerParam` is the target function's own caller-parameter name — it
// differs by contract (`admin` for privacy-pool/reputation-verifier/
// relayer-registry vs. `caller` for attestation-engine-v2, per each
// contract's transfer_admin/transfer_governance signature in
// contracts/<name>/src/lib.rs) and must match exactly for the CLI's
// `--<param> <value>` invocation to bind correctly.
const REGISTRIES = {
  privacyPool: {
    manifestKey: "privacyPool",
    calls: [{ fn: "transfer_admin", callerParam: "admin", newParam: "new_admin" }],
  },
  reputationVerifier: {
    manifestKey: "reputationVerifier",
    calls: [{ fn: "transfer_admin", callerParam: "admin", newParam: "new_admin" }],
  },
  relayerRegistry: {
    manifestKey: "relayerRegistry",
    calls: [{ fn: "transfer_admin", callerParam: "admin", newParam: "new_admin" }],
  },
  // attestation-engine-v2 has BOTH admin and governance to migrate — see
  // docs/MULTISIG_ADMIN.md's note that both must move to fully remove
  // single-key access. Both entrypoints take `caller` (not `admin`) as the
  // authorizing-party parameter name.
  attestationEngineV2: {
    manifestKey: "attestationEngineV2",
    calls: [
      { fn: "transfer_admin", callerParam: "caller", newParam: "new_admin" },
      { fn: "transfer_governance", callerParam: "caller", newParam: "new_governance" },
    ],
  },
};

async function main() {
  const network = arg("network", process.env.STELLAR_NETWORK || "testnet");
  const dryRun = flag("dry-run");
  const skipBuild = flag("skip-build");
  const only = multiArg("only");

  if (network !== "testnet" && network !== "mainnet") {
    fail(`Unsupported network "${network}". Use testnet or mainnet.`);
  }

  const signersRaw = arg("signers");
  const thresholdRaw = arg("threshold");
  if (!signersRaw) fail("Missing --signers <G...,G...,...> (comma-separated, no spaces).");
  const signers = signersRaw.split(",").map((s) => s.trim());
  if (signers.length < 2) fail(`--signers must list at least 2 addresses (got ${signers.length}).`);
  for (const s of signers) {
    if (!G_ADDRESS.test(s)) fail(`Not a valid Stellar G-address: "${s}"`);
  }
  const uniqueSigners = new Set(signers);
  if (uniqueSigners.size !== signers.length) fail("--signers contains a duplicate address.");

  const threshold = Number(thresholdRaw);
  if (!Number.isInteger(threshold) || threshold < 2) {
    fail(`--threshold must be an integer >= 2 (got "${thresholdRaw}").`);
  }
  if (threshold > signers.length) {
    fail(`--threshold (${threshold}) cannot exceed the signer count (${signers.length}).`);
  }

  const targets = only.length > 0 ? only : Object.keys(REGISTRIES);
  for (const t of targets) {
    if (!(t in REGISTRIES)) {
      fail(`Unknown --only target "${t}". Valid: ${Object.keys(REGISTRIES).join(", ")}`);
    }
  }

  const identity = process.env.STELLAR_DEPLOYER?.trim();
  const secret = process.env.STELLAR_DEPLOYER_SECRET?.trim();
  const source = identity || secret;
  if (!dryRun && !source) {
    fail(
      "No deployer configured. Set STELLAR_DEPLOYER (identity name) or " +
        "STELLAR_DEPLOYER_SECRET (S... seed) in your .env. This MUST be the account that " +
        "currently holds admin on every registry being migrated — transfer_admin's " +
        "require_auth() check compares against the registry's CURRENT config.admin.",
    );
  }

  const manifestPath = join(ROOT, "deployments", "v1", `${network}.json`);
  if (!existsSync(manifestPath)) fail(`Missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.multisig && manifest.multisig.address) {
    fail(
      `Manifest already records a deployed multisig at ${manifest.multisig.address}. ` +
        "This script does not support re-running against an already-migrated manifest — " +
        "if you intend to rotate signers on the EXISTING multisig, use propose_rotation/approve " +
        "directly (see docs/MULTISIG_ADMIN.md), not this deploy-and-transfer script.",
    );
  }

  console.log(`\nOpaque Stellar multisig-admin migration → ${network}${dryRun ? " (dry run)" : ""}\n`);
  console.log(`  Signers (${signers.length}):`);
  for (const s of signers) console.log(`    - ${s}`);
  console.log(`  Threshold: ${threshold} of ${signers.length}`);
  console.log(`  Migrating: ${targets.join(", ")}`);
  console.log("");

  if (!skipBuild) {
    console.log("• Building contracts (stellar contract build)…");
    sh("stellar", ["contract", "build"], { stdio: "inherit" });
  }

  const wasmPath = join(ROOT, "target", "wasm32v1-none", "release", "multisig_admin.wasm");
  if (!existsSync(wasmPath)) {
    fail(`WASM not found: ${wasmPath} (run without --skip-build first).`);
  }
  const wasmHash = sha256File(wasmPath);
  console.log(`• multisig-admin wasmHash=${wasmHash}`);

  if (dryRun) {
    console.log("\n[dry-run] Would deploy multisig-admin, then call:");
    console.log(`  multisig.initialize(signers=[${signers.join(", ")}], threshold=${threshold})`);
    for (const t of targets) {
      const reg = REGISTRIES[t];
      const contractId = manifest.contracts?.[reg.manifestKey]?.id ?? manifest.wiring?.[reg.manifestKey]?.id;
      for (const call of reg.calls) {
        console.log(
          `  ${t} (${contractId ?? "<not yet in manifest>"}).${call.fn}(${call.callerParam}=<current admin>, ${call.newParam}=<multisig address>)`,
        );
      }
    }
    console.log("\n[dry-run] No transactions were submitted. Nothing was changed on-chain or in the manifest.");
    return;
  }

  console.log("• Deploying multisig-admin…");
  const deployOut = sh("stellar", [
    "contract",
    "deploy",
    "--wasm",
    wasmPath,
    "--source-account",
    source,
    "--network",
    network,
    "--",
  ]);
  const multisigId = deployOut.trim().split("\n").pop().trim();
  if (!multisigId || !multisigId.startsWith("C")) {
    fail(`Unexpected deploy output, could not extract contract ID:\n${deployOut}`);
  }
  console.log(`  deployed: ${multisigId}`);

  console.log("• Initializing multisig-admin (signers + threshold)…");
  invoke(multisigId, source, network, [
    "initialize",
    "--signers",
    JSON.stringify(signers),
    "--threshold",
    String(threshold),
  ]);

  const verifyOut = invoke(multisigId, source, network, ["get_config"]);
  const config = parseInvokeResult(verifyOut);
  if (!config || config.threshold !== threshold || (config.signers?.length ?? 0) !== signers.length) {
    fail(`get_config() after initialize did not match what was requested. Raw output:\n${verifyOut}`);
  }
  console.log(`  verified on-chain: ${config.signers.length} signers, threshold ${config.threshold}`);

  const migrated = [];
  for (const t of targets) {
    const reg = REGISTRIES[t];
    const contractId = manifest.contracts?.[reg.manifestKey]?.id ?? manifest.wiring?.[reg.manifestKey]?.id;
    if (!contractId) {
      console.error(`  ✗ ${t}: no contract id found in manifest — SKIPPED. Fix the manifest and re-run with --only ${t}.`);
      continue;
    }

    let ok = true;
    for (let i = 0; i < reg.calls.length; i++) {
      const call = reg.calls[i];
      console.log(`• ${t}.${call.fn}(${call.callerParam}=<current admin>, ${call.newParam}=${multisigId})…`);
      try {
        // `source` (the STELLAR_DEPLOYER identity/secret) both signs the
        // transaction AND is passed as the caller-parameter value — the
        // contract's require_auth() check compares the parameter's address
        // against config.admin, so these must be the same account.
        invoke(contractId, source, network, [
          call.fn,
          `--${call.callerParam}`,
          source,
          `--${call.newParam}`,
          multisigId,
        ]);
      } catch (err) {
        console.error(`  ✗ ${t}.${call.fn} failed: ${err.message}`);
        console.error(
          `    This registry's admin was NOT changed. If ${i > 0} earlier calls in this ` +
            "registry's migration already succeeded, that registry is now in a PARTIALLY migrated state " +
            "(e.g. admin moved but governance did not) — resolve manually before re-running.",
        );
        ok = false;
        break;
      }
    }
    if (ok) {
      migrated.push(t);
      const roles = reg.calls.map((c) => c.newParam.replace("new_", "")).join("/");
      console.log(`  ✓ ${t} ${roles} transferred to ${multisigId}`);
    }
  }

  // Record the migration in the manifest — this is the "documented" half of
  // "admin operations require the documented signature threshold": get_config()
  // is the on-chain verification, this is the human-readable record.
  manifest.multisig = {
    address: multisigId,
    wasmHash,
    signers,
    threshold,
    migratedRegistries: migrated,
    migratedAt: new Date().toISOString(),
  };
  for (const t of migrated) {
    if (manifest.wiring?.[t]) manifest.wiring[t].admin = multisigId;
    if (t === "attestationEngineV2" && manifest.wiring?.[t]) manifest.wiring[t].governance = multisigId;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`\n• Manifest updated: ${manifestPath}`);

  const failed = targets.filter((t) => !migrated.includes(t));
  if (failed.length > 0) {
    fail(
      `Migration partially completed. Migrated: [${migrated.join(", ")}]. ` +
        `NOT migrated: [${failed.join(", ")}]. Re-run with --only <name> for each failed registry ` +
        "after resolving the error above.",
    );
  }

  console.log(
    `\n✓ Migration complete. multisig-admin=${multisigId}, threshold=${threshold}/${signers.length}.\n` +
      "  Next: update docs/AGENT_KEY_COMPROMISE_RUNBOOK.md and any other operational " +
      "runbooks that assume a single admin key, per docs/MULTISIG_MIGRATION_RUNBOOK.md step 6.\n",
  );
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
