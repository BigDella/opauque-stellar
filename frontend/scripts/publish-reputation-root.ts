/**
 * Phase 3 — Reputation attestation indexer + Merkle-root publisher.
 *
 * Builds the Poseidon Merkle tree of V2 attestation leaves (matching the Rust
 * scanner + circuit via lib/merkleV2.ts) and publishes its root on-chain via
 * reputation-verifier.update_merkle_root(root, dataset_hash). Also supports the
 * root lifecycle (set_root_expiry) and a deterministic dataset hash.
 *
 * IMPORTANT privacy note: a V2 leaf is
 *   Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)
 * where stealth_pk (the holder's stealth private key) and trait_data_hash (from
 * the holder's decrypted attestation data) are SECRETS only the holder knows. A
 * third-party indexer therefore cannot derive leaves on its own — in production,
 * holders publish their leaf *commitment* (a hash that reveals nothing) which the
 * indexer trees. This module takes the set of leaf commitments as input and is
 * agnostic to where they come from. `parseV2Announcement` decodes the PUBLIC
 * metadata an indexer can read from stealth-announcer to assist that flow.
 *
 * Reusable functions are exported; a thin CLI publishes a root from a leaves file.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Keypair,
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  rpc,
  xdr,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { getPoseidon, MerkleV2, toBE32, V2_TREE_DEPTH } from "./lib/merkleV2.ts";

const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Build the reputation Merkle tree from a list of leaf field elements. */
export async function buildReputationTree(leaves: bigint[]): Promise<MerkleV2> {
  const poseidon = await getPoseidon();
  const tree = new MerkleV2(poseidon, V2_TREE_DEPTH);
  for (const leaf of leaves) tree.insert(leaf);
  return tree;
}

/**
 * Deterministic dataset hash binding the published root to the exact leaf set:
 * sha256( leafCount(4B BE) || rootBE || each leafBE ). A verifier with the same
 * leaves recomputes the same hash.
 */
export function computeDatasetHash(rootBE: Uint8Array, leaves: bigint[]): Uint8Array {
  const h = createHash("sha256");
  const count = Buffer.alloc(4);
  count.writeUInt32BE(leaves.length >>> 0, 0);
  h.update(count);
  h.update(Buffer.from(rootBE));
  for (const leaf of leaves) h.update(Buffer.from(toBE32(leaf)));
  return Uint8Array.from(h.digest());
}

/** Decode the PUBLIC fields of a V2 attestation announcement metadata (marker 0xB2). */
export function parseV2Announcement(metadata: Uint8Array): {
  viewTag: number;
  schemaId: Uint8Array;
  issuer: Uint8Array;
  attestationUid: Uint8Array;
  nonce: Uint8Array;
  expirationLedger: number;
} | null {
  if (metadata.length < 130 || metadata[1] !== 0xb2) return null;
  const view = (a: number, b: number) => metadata.slice(a, b);
  const expiration =
    metadata.length >= 134
      ? new DataView(metadata.buffer, metadata.byteOffset + 130, 4).getUint32(0, false)
      : 0;
  return {
    viewTag: metadata[0],
    schemaId: view(2, 34),
    issuer: view(34, 66),
    attestationUid: view(66, 98),
    nonce: view(98, 130),
    expirationLedger: expiration,
  };
}

// ----------------------------------------------------------------------------
// On-chain publish helpers
// ----------------------------------------------------------------------------
const server = new rpc.Server(RPC_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function invoke(adminKp: any, reputationId: string, method: string, args: any[]): Promise<any> {
  const acct = await server.getAccount(adminKp.publicKey());
  let tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(reputationId).call(method, ...args))
    .setTimeout(120)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(adminKp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`${method}: send rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return { hash: sent.hash, ledger: r.ledger };
    if (r.status === "FAILED") throw new Error(`${method}: tx FAILED ${sent.hash}`);
  }
  throw new Error(`${method}: not confirmed`);
}

const addr = (pub: string) => new Address(pub).toScVal();
const bytesScVal = (u8: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(u8));

/** Publish a Merkle root + dataset hash via reputation-verifier.update_merkle_root. */
export async function publishRoot(adminKp: any, reputationId: string, rootBE: Uint8Array, datasetHashBE: Uint8Array) {
  return invoke(adminKp, reputationId, "update_merkle_root", [addr(adminKp.publicKey()), bytesScVal(rootBE), bytesScVal(datasetHashBE)]);
}

/** Set the root validity window (ledgers) via reputation-verifier.set_root_expiry. */
export async function setRootExpiry(adminKp: any, reputationId: string, expiryLedgers: number) {
  return invoke(adminKp, reputationId, "set_root_expiry", [addr(adminKp.publicKey()), nativeToScVal(expiryLedgers, { type: "u32" })]);
}

// ----------------------------------------------------------------------------
// CLI: publish a root from a JSON file of decimal/hex leaf field elements.
//   DEPLOYER_SECRET=... npx tsx scripts/publish-reputation-root.ts <leaves.json>
// ----------------------------------------------------------------------------
async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, "..", "..");
  const manifest = JSON.parse(readFileSync(join(repoRoot, "deployments", "v1", "testnet.json"), "utf8"));
  const reputationId = manifest.contracts.reputationVerifier.id;

  const leavesFile = process.argv[2];
  if (!leavesFile) throw new Error("usage: publish-reputation-root.ts <leaves.json>");
  const leaves: bigint[] = JSON.parse(readFileSync(leavesFile, "utf8")).map((x: string) => BigInt(x));

  const secret = process.env.DEPLOYER_SECRET?.trim();
  if (!secret) throw new Error("set DEPLOYER_SECRET (stellar keys show opaque-deployer)");
  const admin = Keypair.fromSecret(secret);

  const tree = await buildReputationTree(leaves);
  const rootBE = toBE32(tree.root());
  const datasetHash = computeDatasetHash(rootBE, leaves);
  console.log(`Publishing root ${Buffer.from(rootBE).toString("hex")} (${leaves.length} leaves) to ${reputationId}`);
  const res = await publishRoot(admin, reputationId, rootBE, datasetHash);
  console.log(`update_merkle_root ✓ ${res.hash}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
