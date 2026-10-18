/**
 * Drift detection: compare on-chain WASM hashes against deployment manifest entries.
 *
 * For every contract in the active manifest, fetches the WASM hash currently
 * installed on-chain via Soroban RPC and compares it to the manifest's recorded
 * wasmHash. Any divergence is reported with the contract name, expected hash, and
 * actual on-chain hash.
 *
 * Usage:
 *   npm run drift:check
 *   npx tsx scripts/drift-check.ts
 *   npx tsx scripts/drift-check.ts --network testnet
 *   npx tsx scripts/drift-check.ts --network testnet --json
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rpc, xdr } from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function parseArgs(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  return {
    network: opt("network", "testnet"),
    json: argv.includes("--json"),
  };
}

function loadManifest(network) {
  const path = join(ROOT, "deployments", "v1", `${network}.json`);
  if (!existsSync(path)) throw new Error(`Missing manifest: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Fetch the WASM hash currently installed for a contract on-chain.
 * Uses getLedgerEntries to read the ContractData entry that stores the
 * executable (WASM hash) for the given contract ID.
 */
async function fetchOnChainWasmHash(server, contractId) {
  const contractKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(
        xdr.Hash.fromXDR(
          Buffer.from(
            // Stellar contract IDs are Strkey-encoded; decode to raw bytes
            (() => {
              const { StrKey } = require("@stellar/stellar-sdk");
              return StrKey.decodeContract(contractId);
            })(),
          ),
        ),
      ),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const res = await server.getLedgerEntries(contractKey);
  const entry = res.entries?.[0];
  if (!entry) return null;

  const data = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64");
  const instance = data.contractData().val().instance();
  const executable = instance.executable();

  if (executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()) {
    return executable.wasmHash().toString("hex");
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(opts.network);
  const rpcUrl = manifest.rpcUrl;
  if (!rpcUrl) throw new Error(`No rpcUrl in ${opts.network} manifest`);

  const server = new rpc.Server(rpcUrl);

  const contracts = manifest.contracts ?? {};
  const results = [];
  let driftCount = 0;

  for (const [name, record] of Object.entries(contracts)) {
    const { id, wasmHash } = record;
    if (!id || !wasmHash) {
      results.push({ name, id, status: "skipped", reason: "missing id or wasmHash in manifest" });
      continue;
    }

    let onChainHash;
    let error;
    try {
      onChainHash = await fetchOnChainWasmHash(server, id);
    } catch (err) {
      error = err?.message ?? String(err);
    }

    if (error) {
      results.push({ name, id, status: "error", reason: error });
      continue;
    }

    if (!onChainHash) {
      results.push({ name, id, status: "error", reason: "contract not found on-chain or not a WASM contract" });
      continue;
    }

    const drifted = onChainHash !== wasmHash;
    if (drifted) driftCount++;

    results.push({
      name,
      id,
      status: drifted ? "DRIFT" : "ok",
      manifestHash: wasmHash,
      onChainHash,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({ network: opts.network, driftCount, results }, null, 2));
    process.exitCode = driftCount > 0 ? 1 : 0;
    return;
  }

  console.log(`\nDrift check — ${opts.network}\n`);
  for (const r of results) {
    if (r.status === "ok") {
      console.log(`  OK      ${r.name} (${r.id})`);
    } else if (r.status === "DRIFT") {
      console.log(`  DRIFT   ${r.name} (${r.id})`);
      console.log(`          manifest : ${r.manifestHash}`);
      console.log(`          on-chain : ${r.onChainHash}`);
    } else if (r.status === "skipped") {
      console.log(`  SKIP    ${r.name} — ${r.reason}`);
    } else {
      console.log(`  ERROR   ${r.name} — ${r.reason}`);
    }
  }

  if (driftCount > 0) {
    console.log(`\n${driftCount} contract(s) have drifted from the manifest.`);
    console.log("Update deployments/v1/${opts.network}.json or redeploy the affected contracts.");
    process.exitCode = 1;
  } else {
    console.log(`\nAll contracts match the manifest.`);
  }
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
