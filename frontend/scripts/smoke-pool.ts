/**
 * Phase 5 headless e2e smoke for the privacy pool, driven by a raw Keypair (no browser).
 *
 *   deposit → publish state root → publish ASP root → prove (snarkjs v3) → partial withdraw
 *   → assert the recipient/relayer payout split + nullifier replay rejection.
 *
 * Proves the full association-set withdrawal loop on Stellar testnet. The state + ASP roots
 * are computed with the same depth-20 Poseidon helper the contract and circuit use
 * (single-leaf trees here; the production ASP indexer trees all deposits — see asp/).
 *
 * Run: DEPLOYER_SECRET=$(stellar keys show opaque-deployer) npm run smoke:pool
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import * as snarkjs from "snarkjs";
import { getPoseidon, MerkleV2, toBE32, hashFields, V2_TREE_DEPTH } from "./lib/merkleV2.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FRONTEND = join(__dirname, "..");
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const WASM = join(FRONTEND, "public/circuits/v3/privacy_pool_withdraw.wasm");
const ZKEY = join(FRONTEND, "public/circuits/v3/privacy_pool_withdraw_final.zkey");

const server = new rpc.Server(RPC_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randFr(): bigint {
  return BigInt("0x" + Buffer.from(randomBytes(31)).toString("hex")) % R;
}

function beBytes(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let n = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** Must byte-match privacy-pool::compute_context. */
function computeContext(recipientPub: string, withdrawn: bigint, fee: bigint, relayerPub: string, scope: bigint): bigint {
  const recXdr = new Uint8Array(new Address(recipientPub).toScVal().toXDR());
  const relXdr = new Uint8Array(new Address(relayerPub).toScVal().toXDR());
  const preimage = concatBytes(recXdr, beBytes(withdrawn, 16), beBytes(fee, 16), relXdr, beBytes(scope, 8));
  const digest = keccak_256(preimage);
  let v = 0n;
  for (const b of digest) v = (v << 8n) + BigInt(b);
  return v % R;
}

const bytesScVal = (u8: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(u8));
const i128ScVal = (v: bigint) => nativeToScVal(v, { type: "i128" });

async function invoke(kp: any, contractId: string, method: string, args: any[]): Promise<any> {
  const acct = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`${method} send rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return scValToNative(r.returnValue);
    if (r.status === "FAILED") throw new Error(`${method} FAILED ${sent.hash}: ${JSON.stringify(r.resultXdr ?? "")}`);
  }
  throw new Error(`${method} not confirmed`);
}

async function simulateRead(kp: any, contractId: string, method: string, args: any[]): Promise<any> {
  const acct = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`sim ${method}: ${sim.error}`);
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

async function nativeBalance(kp: any, sac: string, who: string): Promise<bigint> {
  const v = await simulateRead(kp, sac, "balance", [new Address(who).toScVal()]);
  return BigInt(v ?? 0);
}

async function friendbot(pub: string) {
  await fetch(`https://friendbot.stellar.org/?addr=${pub}`).catch(() => {});
}

/** Build a single-leaf depth-20 tree; returns root + index-0 inclusion path. */
async function singleLeafTree(leaf: bigint) {
  const poseidon = await getPoseidon();
  const tree = new MerkleV2(poseidon, V2_TREE_DEPTH);
  tree.insert(leaf);
  const { pathElements, pathIndices, root } = tree.proof(0);
  return { root, pathElements, pathIndices };
}

function proofToBytes(proof: any): { a: Uint8Array; b: Uint8Array; c: Uint8Array } {
  const piA = proof.pi_a.map(BigInt);
  const piBflat = proof.pi_b.slice(0, 2).flatMap((p: string[]) => [BigInt(p[1]), BigInt(p[0])]);
  const piC = proof.pi_c.map(BigInt);
  const a = new Uint8Array(64);
  a.set(toBE32(piA[0]), 0);
  a.set(toBE32(piA[1]), 32);
  const b = new Uint8Array(128);
  for (let i = 0; i < 4; i++) b.set(toBE32(piBflat[i]), i * 32);
  const c = new Uint8Array(64);
  c.set(toBE32(piC[0]), 0);
  c.set(toBE32(piC[1]), 32);
  return { a, b, c };
}

function datasetHash(leaves: bigint[]): Uint8Array {
  const h = createHash("sha256");
  for (const l of leaves) h.update(Buffer.from(toBE32(l)));
  return Uint8Array.from(h.digest());
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "v1", "testnet.json"), "utf8"));
  const poolId = manifest.contracts.privacyPool.id;
  const sac = manifest.wiring.privacyPool.nativeSac;
  const scope = BigInt(manifest.wiring.privacyPool.scope ?? 1);
  if (!poolId) throw new Error("privacyPool not deployed");

  const secret = process.env.DEPLOYER_SECRET?.trim();
  if (!secret) throw new Error("set DEPLOYER_SECRET (stellar keys show opaque-deployer)");
  const admin = Keypair.fromSecret(secret); // admin = depositor = relayer here
  const recipient = Keypair.random();

  console.log(`Pool ${poolId} | scope ${scope} | recipient ${recipient.publicKey()}`);
  console.log("• Funding fresh recipient via friendbot…");
  await friendbot(recipient.publicKey());
  await sleep(6000);

  const poseidon = await getPoseidon();
  const value = 50_000_000n; // 5 XLM
  const withdrawn = 20_000_000n; // 2 XLM
  const fee = 1_000_000n; // 0.1 XLM
  const remainder = value - withdrawn;

  // Secrets (fresh per run so the nullifier is unused).
  const nullifier = randFr();
  const secretField = randFr();
  const newNullifier = randFr();
  const newSecret = randFr();

  const index = BigInt(await simulateRead(admin, poolId, "get_deposit_count", []));
  const label = hashFields(poseidon, [scope, index]);
  const precommitment = hashFields(poseidon, [nullifier, secretField]);
  const commitment = hashFields(poseidon, [value, label, precommitment]);
  const nullifierHash = hashFields(poseidon, [nullifier]);
  const newPrecommitment = hashFields(poseidon, [newNullifier, newSecret]);
  const newCommitment = hashFields(poseidon, [remainder, label, newPrecommitment]);

  console.log(`• Depositing ${value} stroops at index ${index}…`);
  await invoke(admin, poolId, "deposit", [
    new Address(admin.publicKey()).toScVal(),
    i128ScVal(value),
    bytesScVal(toBE32(commitment)),
    nativeToScVal(index, { type: "u64" }),
  ]);

  // Publish state + ASP roots (single-leaf trees; production indexer/ASP tree all deposits).
  const state = await singleLeafTree(commitment);
  const asp = await singleLeafTree(label);
  console.log("• Publishing state root…");
  await invoke(admin, poolId, "update_state_root", [
    new Address(admin.publicKey()).toScVal(),
    bytesScVal(toBE32(state.root)),
    bytesScVal(datasetHash([commitment])),
  ]);
  console.log("• Publishing ASP root…");
  await invoke(admin, poolId, "update_asp_root", [
    new Address(admin.publicKey()).toScVal(),
    bytesScVal(toBE32(asp.root)),
    bytesScVal(datasetHash([label])),
  ]);

  // Prove.
  const context = computeContext(recipient.publicKey(), withdrawn, fee, admin.publicKey(), scope);
  const input = {
    withdrawnValue: withdrawn.toString(),
    stateRoot: state.root.toString(),
    aspRoot: asp.root.toString(),
    nullifierHash: nullifierHash.toString(),
    newCommitment: newCommitment.toString(),
    context: context.toString(),
    value: value.toString(),
    label: label.toString(),
    nullifier: nullifier.toString(),
    secret: secretField.toString(),
    newNullifier: newNullifier.toString(),
    newSecret: newSecret.toString(),
    stateSiblings: state.pathElements.map((x: bigint) => x.toString()),
    stateIndex: state.pathIndices.map((x: number) => x.toString()),
    aspSiblings: asp.pathElements.map((x: bigint) => x.toString()),
    aspIndex: asp.pathIndices.map((x: number) => x.toString()),
  };
  console.log("• Generating withdraw proof (snarkjs v3)…");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  console.log(`  public signals: ${publicSignals.join(", ")}`);
  const { a, b, c } = proofToBytes(proof);

  const recipBefore = await nativeBalance(admin, sac, recipient.publicKey());
  const poolBefore = await nativeBalance(admin, sac, poolId);

  console.log("• Withdrawing…");
  await invoke(admin, poolId, "withdraw", [
    bytesScVal(a),
    bytesScVal(b),
    bytesScVal(c),
    i128ScVal(withdrawn),
    bytesScVal(toBE32(state.root)),
    bytesScVal(toBE32(asp.root)),
    bytesScVal(toBE32(nullifierHash)),
    bytesScVal(toBE32(newCommitment)),
    new Address(recipient.publicKey()).toScVal(),
    i128ScVal(fee),
    new Address(admin.publicKey()).toScVal(),
  ]);

  const recipAfter = await nativeBalance(admin, sac, recipient.publicKey());
  const poolAfter = await nativeBalance(admin, sac, poolId);
  const payout = withdrawn - fee;

  console.log(`  recipient: ${recipBefore} → ${recipAfter} (Δ ${recipAfter - recipBefore}, expected ${payout})`);
  console.log(`  pool:      ${poolBefore} → ${poolAfter} (Δ ${poolAfter - poolBefore}, expected ${-withdrawn})`);
  if (recipAfter - recipBefore !== payout) throw new Error("recipient payout mismatch");
  if (poolBefore - poolAfter !== withdrawn) throw new Error("pool debit mismatch");

  const spent = await simulateRead(admin, poolId, "is_spent", [bytesScVal(toBE32(nullifierHash))]);
  if (spent !== true) throw new Error("nullifier should be spent");

  console.log("• Asserting nullifier replay is rejected…");
  let replayRejected = false;
  try {
    await invoke(admin, poolId, "withdraw", [
      bytesScVal(a), bytesScVal(b), bytesScVal(c), i128ScVal(withdrawn),
      bytesScVal(toBE32(state.root)), bytesScVal(toBE32(asp.root)),
      bytesScVal(toBE32(nullifierHash)), bytesScVal(toBE32(newCommitment)),
      new Address(recipient.publicKey()).toScVal(), i128ScVal(fee),
      new Address(admin.publicKey()).toScVal(),
    ]);
  } catch {
    replayRejected = true;
  }
  if (!replayRejected) throw new Error("nullifier replay should have been rejected");

  console.log("\n✅ smoke:pool passed — deposit → roots → prove → partial withdraw → replay rejected");
}

main().catch((e) => {
  console.error(`\n✗ ${e?.message ?? e}`);
  process.exit(1);
});
