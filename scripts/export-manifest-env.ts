/**
 * Prints GitHub Actions / shell env exports from a deployment manifest.
 *
 * Usage: eval "$(npx tsx scripts/export-manifest-env.ts testnet)"
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ENV_SUFFIX = {
  stealthRegistry: "STEALTH_REGISTRY_CONTRACT",
  stealthAnnouncer: "STEALTH_ANNOUNCER_CONTRACT",
  groth16Verifier: "GROTH16_VERIFIER_CONTRACT",
  reputationVerifier: "REPUTATION_VERIFIER_CONTRACT",
  schemaRegistry: "SCHEMA_REGISTRY_CONTRACT",
  attestationEngineV2: "ATTESTATION_ENGINE_CONTRACT",
};

const network = process.argv[2];
if (!network) {
  console.error("Usage: node scripts/export-manifest-env.mjs <testnet|mainnet>");
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync(join(ROOT, "deployments", "v1", `${network}.json`), "utf8"),
);

const prefix = network.toUpperCase();
const lines = [
  `export VITE_STELLAR_NETWORK=${network}`,
  `export VITE_STELLAR_NETWORK_PASSPHRASE='${manifest.networkPassphrase}'`,
];

if (manifest.rpcUrl) lines.push(`export VITE_STELLAR_RPC_URL='${manifest.rpcUrl}'`);
if (manifest.horizonUrl) lines.push(`export VITE_STELLAR_HORIZON_URL='${manifest.horizonUrl}'`);

for (const [key, record] of Object.entries(manifest.contracts)) {
  const suffix = ENV_SUFFIX[key];
  if (!suffix || !record.id) continue;
  lines.push(`export VITE_${prefix}_${suffix}='${record.id}'`);
}

console.log(lines.join("\n"));
