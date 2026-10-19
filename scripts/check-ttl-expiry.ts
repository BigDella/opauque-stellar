

import { readFileSync, existsSync } from "node:fs";

/** Checks the TTL of every deployed contract's instance ledger entry via Soroban RPC. */
import { existsSync, readFileSync } from "node:fs";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, rpc, xdr } from "@stellar/stellar-sdk";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOYMENTS = join(ROOT, "deployments", "v1");
const DEFAULT_THRESHOLD = 518_400;
type Manifest = { rpcUrl?: string; contracts: Record<string, { id: string | null }> };

function parseArgs(argv: string[]) {
  let network = "testnet"; let contractFilter: string | undefined; let threshold = DEFAULT_THRESHOLD;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--network" && argv[index + 1]) network = argv[++index];
    else if (argv[index] === "--contract" && argv[index + 1]) contractFilter = argv[++index];
    else if (argv[index] === "--threshold" && argv[index + 1]) threshold = Number(argv[++index]);
  }
  if (!Number.isSafeInteger(threshold) || threshold < 0) throw new Error("--threshold must be a non-negative integer");
  return { network, contractFilter, threshold };
}

function loadManifest(network: string): Manifest {
  const path = join(DEPLOYMENTS, `${network}.json`);
  if (!existsSync(path)) throw new Error(`Deployment manifest not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: new Contract(contractId).address().toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
  }));
}

async function main(): Promise<void> {
  const { network, contractFilter, threshold } = parseArgs(process.argv);
  const manifest = loadManifest(network);
  if (!manifest.rpcUrl) throw new Error(`Deployment manifest for ${network} has no rpcUrl`);
  const contracts = Object.entries(manifest.contracts)
    .filter(([, contract]) => typeof contract.id === "string" && contract.id.length > 0)
    .map(([name, contract]) => ({ name, id: contract.id as string }))
    .filter(({ name, id }) => !contractFilter || contractFilter === name || contractFilter === id);
  if (contracts.length === 0) throw new Error("No deployed contracts match the requested filter");

  const response = await new rpc.Server(manifest.rpcUrl).getLedgerEntries(...contracts.map(({ id }) => instanceKey(id)));
  const byKey = new Map(response.entries.map((entry) => [entry.key.toXDR("base64"), entry]));
  let expiring = 0; let failures = 0;
  console.log(`TTL expiry check — network: ${network}, latest ledger: ${response.latestLedger}`);
  for (const { name, id } of contracts) {
    const entry = byKey.get(instanceKey(id).toXDR("base64"));
    if (!entry || entry.liveUntilLedgerSeq === undefined) {
      console.error(`FAIL: ${name} (${id}) has no readable instance TTL`); failures += 1; continue;
    }
    const remaining = Math.max(0, entry.liveUntilLedgerSeq - response.latestLedger);
    console.log(`${remaining < threshold ? "EXPIRING" : "OK"}: ${name} liveUntilLedger=${entry.liveUntilLedgerSeq} remaining=${remaining}`);
    if (remaining < threshold) expiring += 1;
  }
  if (failures || expiring) throw new Error(`${failures} lookup failure(s), ${expiring} contract(s) below the TTL threshold`);
  console.log("PASS: Every deployed contract has sufficient instance TTL headroom.");
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
