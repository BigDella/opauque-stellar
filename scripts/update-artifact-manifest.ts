/**
 * Compute SHA-256 hashes for build artifacts and write artifacts/manifest.json.
 * Optionally syncs circuit/scanner hashes into deployments/v1/*.json.
 *
 * Usage:
 *   npm run update:artifacts
 *   npx tsx scripts/update-artifact-manifest.ts --sync-deployments
 *   npx tsx scripts/update-artifact-manifest.ts --embedded-vk
 */

import { existsSync } from "node:fs";
import {
  loadManifest,
  saveManifest,
  sha256File,
  resolveArtifactPath,
  hashEmbeddedContractVk,
  syncDeploymentManifestCircuitHashes,
} from "./artifact-manifest-lib.ts";

function parseArgs(argv) {
  return {
    syncDeployments: argv.includes("--sync-deployments"),
    embeddedVk: argv.includes("--embedded-vk") || !argv.includes("--no-embedded-vk"),
  };
}

function updatePathEntry(entry) {
  const full = resolveArtifactPath(entry.path);
  if (!existsSync(full)) {
    console.warn(`Skip ${entry.path}: not found`);
    return;
  }
  entry.sha256 = sha256File(full);
  console.log(`${entry.path}: ${entry.sha256}`);
}

function main() {
  const opts = parseArgs(process.argv);
  const manifest = loadManifest();

  for (const entry of Object.values(manifest.scanner.files)) {
    updatePathEntry(entry);
    // Enforce single-hash policy: strip any stale alternates.
    delete entry.sha256Alternates;
  }

  for (const version of Object.keys(manifest.circuits)) {
    const circuit = manifest.circuits[version];
    for (const entry of Object.values(circuit.frontend)) updatePathEntry(entry);
    for (const entry of Object.values(circuit.build)) updatePathEntry(entry);

    const ref = circuit.contractVk?.referenceVerificationKey;
    if (ref) updatePathEntry(ref);

    if (opts.embeddedVk) {
      try {
        const suffix = version === "v1" ? "" : `_${version.toUpperCase()}`;
        const hash = hashEmbeddedContractVk(circuit.contractVk.groth16Verifier, { suffix });
        circuit.contractVk.embeddedVkHash = hash;
        console.log(`circuits.${version} embedded VK: ${hash}`);
      } catch (err) {
        console.warn(`Skip embedded VK for ${version}: ${err.message}`);
      }
    }

    if (circuit.frontend.zkey?.sha256) {
      circuit.contractVk.zkeyHash = circuit.frontend.zkey.sha256;
    }
  }

  saveManifest(manifest);

  if (opts.syncDeployments) {
    syncDeploymentManifestCircuitHashes(manifest);
    console.log("Synced circuit/scanner hashes into deployments/v1/*.json");
  }

  console.log(`Updated ${resolveArtifactPath("artifacts/manifest.json")}`);
}

main();
