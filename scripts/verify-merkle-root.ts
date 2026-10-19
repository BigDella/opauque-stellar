#!/usr/bin/env -S npx tsx
/** Verify reputation roots by reading the verifier's Soroban ledger entries. */
import { existsSync, readFileSync } from "node:fs";
import { Contract, rpc, xdr } from "@stellar/stellar-sdk";

type Manifest = { rpcUrl?: string; contracts: { reputationVerifier?: { id: string | null } } };
type RootEntry = { root: string; ledger: number; datasetHash: string };
const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
function requireRoot(value: string): string { if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Root must be 0x followed by 64 hexadecimal characters"); return value.toLowerCase(); }
function contractDataKey(contractId: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Contract(contractId).address().toScAddress(), key, durability: xdr.ContractDataDurability.persistent() }));
}
function bytes(value: xdr.ScVal): string { return `0x${Buffer.from(value.bytes()).toString("hex")}`; }
function historyFromEntry(entry: xdr.LedgerEntryData): string[] {
  const values = entry.contractData().val().vec();
  if (!values) throw new Error("root_history is not a vector");
  return values.toArray().map(bytes);
}
function rootEntryFromLedger(entry: xdr.LedgerEntryData): RootEntry {
  const map = entry.contractData().val().map();
  if (!map) throw new Error("merkle root entry is not a map");
  const fields = new Map(map.toArray().map((field) => [field.key().sym().toString(), field.val()]));
  const root = fields.get("root"), ledger = fields.get("ledger"), datasetHash = fields.get("dataset_hash");
  if (!root || !ledger || !datasetHash) throw new Error("merkle root entry is missing required fields");
  return { root: bytes(root), ledger: ledger.u32(), datasetHash: bytes(datasetHash) };
}

async function main(): Promise<void> {
  const network = argument("--network") ?? "testnet";
  const manifestPath = `deployments/v1/${network}.json`;
  if (!existsSync(manifestPath)) throw new Error(`Deployment manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const contractId = argument("--contract") ?? manifest.contracts.reputationVerifier?.id;
  if (!contractId) throw new Error("No reputation verifier contract is deployed; use --contract to override");
  if (!manifest.rpcUrl) throw new Error(`Deployment manifest for ${network} has no rpcUrl`);
  const requestedRoot = argument("--root"), verifyAll = process.argv.includes("--all");
  if ((requestedRoot ? 1 : 0) + (verifyAll ? 1 : 0) !== 1) throw new Error("Specify exactly one of --root or --all");
  const server = new rpc.Server(manifest.rpcUrl);
  const historyResponse = await server.getLedgerEntries(contractDataKey(contractId, xdr.ScVal.scvSymbol("root_history")));
  if (historyResponse.entries.length !== 1) throw new Error("Unable to read the on-chain root history");
  const roots = historyFromEntry(historyResponse.entries[0].val);
  const targets = requestedRoot ? [requireRoot(requestedRoot)] : roots;
  if (targets.length === 0) throw new Error("No published roots exist on-chain");
  const entries = await server.getLedgerEntries(...targets.map((root) => contractDataKey(contractId, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("merkle_root"), xdr.ScVal.scvBytes(Buffer.from(root.slice(2), "hex"))]))));
  if (entries.entries.length !== targets.length) throw new Error("One or more requested root entries are missing on-chain");
  const expectedDatasetHash = argument("--dataset-hash")?.toLowerCase();
  for (const entry of entries.entries) {
    const rootEntry = rootEntryFromLedger(entry.val);
    if (!targets.includes(rootEntry.root)) throw new Error(`On-chain entry contains unexpected root ${rootEntry.root}`);
    if (expectedDatasetHash && rootEntry.datasetHash !== expectedDatasetHash) throw new Error("On-chain dataset hash does not match --dataset-hash");
    console.log(`OK: ${rootEntry.root} (ledger ${rootEntry.ledger}, dataset ${rootEntry.datasetHash})`);
  }
  console.log(`PASS: verified ${entries.entries.length} root(s) against ${network} RPC ${manifest.rpcUrl}`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? `FAIL: ${error.message}` : error); process.exitCode = 1; });
