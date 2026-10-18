/**
 * Phase 6 headless e2e smoke for relayed privacy-pool withdrawals.
 *
 *   deposit -> publish state/ASP roots -> prove -> create relayer job -> encrypt payload
 *   -> relayer accepts + submits through the registry -> assert payout + nullifier replay.
 *
 * Run: DEPLOYER_SECRET=$(stellar keys show opaque-deployer) npm run smoke:pool:relayer
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
import { RelayerEngine } from "../../relayer/src/engine.ts";
import { StellarRelayerChain } from "../../relayer/src/chains/stellar.ts";
import { makeAdvert } from "../../relayer/src/messages.ts";
import { generateX25519Keypair, sealBox } from "../../relayer/src/shared/box.ts";
import { bytesToHex } from "../../relayer/src/shared/bytes.ts";
import {
  encodePoolWithdrawPayload,
  hashPoolWithdrawPayload,
  type PoolWithdrawPayload,
} from "../../relayer/src/shared/payload.ts";
import { getPoseidon, MerkleV2, toBE32, hashFields, V2_TREE_DEPTH } from "./lib/merkleV2.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FRONTEND = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "deployments/v1/testnet.json"), "utf8"));
const RPC_URL = process.env.STELLAR_RPC_URL ?? manifest.rpcUrl;
const NETWORK_PASSPHRASE = manifest.networkPassphrase;
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
  for (let i = len - 1; i >= 0; i -= 1) {
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

async function invoke(kp: Keypair, contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
  const acct = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(180)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`${method} send rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
  console.log(`  ${method} tx: ${sent.hash}`);
  for (let i = 0; i < 150; i += 1) {
    await sleep(2000);
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return r.returnValue ? scValToNative(r.returnValue) : null;
    if (r.status === "FAILED") throw new Error(`${method} FAILED ${sent.hash}: ${JSON.stringify(r.resultXdr ?? "")}`);
  }
  throw new Error(`${method} not confirmed: ${sent.hash}`);
}

async function simulateRead(kp: Keypair, contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
  const acct = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`sim ${method}: ${sim.error}`);
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

async function nativeBalance(kp: Keypair, sac: string, who: string): Promise<bigint> {
  const v = await simulateRead(kp, sac, "balance", [new Address(who).toScVal()]);
  return BigInt(v ?? 0);
}

async function latestLedger(): Promise<number> {
  return (await server.getLatestLedger()).sequence;
}

async function friendbot(pub: string) {
  await fetch(`https://friendbot.stellar.org/?addr=${pub}`).catch(() => {});
}

async function singleLeafTree(leaf: bigint) {
  const poseidon = await getPoseidon();
  const tree = new MerkleV2(poseidon, V2_TREE_DEPTH);
  tree.insert(leaf);
  const { pathElements, pathIndices, root } = tree.proof(0);
  return { root, pathElements, pathIndices };
}

function proofToBytes(proof: unknown): { a: Uint8Array; b: Uint8Array; c: Uint8Array } {
  const piA = proof.pi_a.map(BigInt);
  const piBflat = proof.pi_b.slice(0, 2).flatMap((p: string[]) => [BigInt(p[1]), BigInt(p[0])]);
  const piC = proof.pi_c.map(BigInt);
  const a = new Uint8Array(64);
  a.set(toBE32(piA[0]), 0);
  a.set(toBE32(piA[1]), 32);
  const b = new Uint8Array(128);
  for (let i = 0; i < 4; i += 1) b.set(toBE32(piBflat[i]), i * 32);
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

async function ensureRegisteredRelayer(operator: Keypair, registryId: string, x25519Pk: Uint8Array, fee: bigint) {
  const existing = await simulateRead(operator, registryId, "get_relayer", [
    new Address(operator.publicKey()).toScVal(),
  ]);
  if (!existing) {
    console.log("• Registering relayer…");
    await invoke(operator, registryId, "register", [
      new Address(operator.publicKey()).toScVal(),
      bytesScVal(x25519Pk),
      nativeToScVal(process.env.RELAYER_ENDPOINT ?? "http://127.0.0.1:8787", { type: "string" }),
      i128ScVal(1_000_000n),
    ]);
    return;
  }
  if (BigInt(existing.free_stake ?? 0) < fee) {
    console.log("• Adding relayer stake…");
    await invoke(operator, registryId, "add_stake", [
      new Address(operator.publicKey()).toScVal(),
      i128ScVal(1_000_000n),
    ]);
  }
}

async function main() {
  const poolId = manifest.contracts.privacyPool?.id;
  const registryId = process.env.RELAYER_REGISTRY_ID ?? manifest.contracts.relayerRegistry?.id;
  const sac = manifest.wiring.privacyPool?.nativeSac;
  const scope = BigInt(manifest.wiring.privacyPool?.scope ?? 1);
  if (!poolId || !registryId || !sac) throw new Error("privacy pool and relayer registry must be deployed");

  const secret = process.env.DEPLOYER_SECRET?.trim();
  if (!secret) throw new Error("set DEPLOYER_SECRET (stellar keys show opaque-deployer)");
  const operator = Keypair.fromSecret(secret);
  const recipient = Keypair.random();
  const x25519Seed = createHash("sha256").update(secret).update("opaque-relayer-x25519-v1").digest();
  const x25519 = generateX25519Keypair(Uint8Array.from(x25519Seed));
  const registryFee = BigInt(process.env.RELAYER_JOB_FEE ?? "100000");

  console.log(`Pool ${poolId} | registry ${registryId} | recipient ${recipient.publicKey()}`);
  console.log(`Relayer ${operator.publicKey()} | X25519 ${bytesToHex(x25519.publicKey)}`);
  console.log("• Funding fresh recipient via friendbot…");
  await friendbot(recipient.publicKey());
  await sleep(6000);
  await ensureRegisteredRelayer(operator, registryId, x25519.publicKey, registryFee);

  const poseidon = await getPoseidon();
  const value = 50_000_000n;
  const withdrawn = 20_000_000n;
  const poolFee = 0n;
  const remainder = value - withdrawn;

  const nullifier = randFr();
  const secretField = randFr();
  const newNullifier = randFr();
  const newSecret = randFr();

  const index = BigInt(await simulateRead(operator, poolId, "get_deposit_count", []));
  const label = hashFields(poseidon, [scope, index]);
  const precommitment = hashFields(poseidon, [nullifier, secretField]);
  const commitment = hashFields(poseidon, [value, label, precommitment]);
  const nullifierHash = hashFields(poseidon, [nullifier]);
  const newPrecommitment = hashFields(poseidon, [newNullifier, newSecret]);
  const newCommitment = hashFields(poseidon, [remainder, label, newPrecommitment]);

  console.log(`• Depositing ${value} stroops at index ${index}…`);
  await invoke(operator, poolId, "deposit", [
    new Address(operator.publicKey()).toScVal(),
    i128ScVal(value),
    bytesScVal(toBE32(commitment)),
    nativeToScVal(index, { type: "u64" }),
  ]);

  const state = await singleLeafTree(commitment);
  const asp = await singleLeafTree(label);
  console.log("• Publishing state root…");
  await invoke(operator, poolId, "update_state_root", [
    new Address(operator.publicKey()).toScVal(),
    bytesScVal(toBE32(state.root)),
    bytesScVal(datasetHash([commitment])),
  ]);
  console.log("• Publishing ASP root…");
  await invoke(operator, poolId, "update_asp_root", [
    new Address(operator.publicKey()).toScVal(),
    bytesScVal(toBE32(asp.root)),
    bytesScVal(datasetHash([label])),
  ]);

  const context = computeContext(recipient.publicKey(), withdrawn, poolFee, registryId, scope);
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

  const payload: PoolWithdrawPayload = {
    poolId,
    proofA: a,
    proofB: b,
    proofC: c,
    withdrawnValue: withdrawn,
    stateRoot: toBE32(state.root),
    aspRoot: toBE32(asp.root),
    nullifierHash: toBE32(nullifierHash),
    newCommitment: toBE32(newCommitment),
    recipient: recipient.publicKey(),
    poolFee,
    poolRelayer: registryId,
  };
  const payloadHash = hashPoolWithdrawPayload(payload);
  const jobId = Uint8Array.from(randomBytes(32));
  const deadline = (await latestLedger()) + 720;

  console.log("• Creating relayer job…");
  await invoke(operator, registryId, "create_job", [
    new Address(operator.publicKey()).toScVal(),
    bytesScVal(jobId),
    bytesScVal(payloadHash),
    nativeToScVal(deadline, { type: "u32" }),
    i128ScVal(registryFee),
  ]);

  const chain = new StellarRelayerChain({
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    registryId,
    operator,
  });
  const engine = new RelayerEngine({
    operator,
    x25519PublicKey: x25519.publicKey,
    x25519SecretKey: x25519.secretKey,
    endpoint: process.env.RELAYER_ENDPOINT ?? "http://127.0.0.1:8787",
    minFee: 1n,
    chain,
  });
  const advert = makeAdvert({ jobId, fee: registryFee, deadline, payloadHash });
  console.log("• Relayer bidding on blind job…");
  const bid = await engine.handleAdvert(advert);
  if (!bid) throw new Error("relayer engine did not bid on the relayed pool job");

  const recipBefore = await nativeBalance(operator, sac, recipient.publicKey());
  const poolBefore = await nativeBalance(operator, sac, poolId);

  console.log("• Encrypting payload and submitting through relayer…");
  const box = sealBox(encodePoolWithdrawPayload(payload), x25519.publicKey);
  const result = await engine.handlePayload({
    t: "payload",
    v: 1,
    jobId: advert.jobId,
    to: bid.x25519Pk,
    box,
  });
  if (!result?.submittedTx) throw new Error("relayer did not submit the pool withdrawal");

  const recipAfter = await nativeBalance(operator, sac, recipient.publicKey());
  const poolAfter = await nativeBalance(operator, sac, poolId);
  const job = await chain.getJob(advert.jobId);

  console.log(`  accepted tx:  ${result.acceptedTx}`);
  console.log(`  submitted tx: ${result.submittedTx}`);
  console.log(`  recipient: ${recipBefore} -> ${recipAfter} (delta ${recipAfter - recipBefore}, expected ${withdrawn})`);
  console.log(`  pool:      ${poolBefore} -> ${poolAfter} (delta ${poolAfter - poolBefore}, expected ${-withdrawn})`);
  if (job?.status !== "submitted") throw new Error(`expected submitted job, got ${job?.status}`);
  if (recipAfter - recipBefore !== withdrawn) throw new Error("recipient payout mismatch");
  if (poolBefore - poolAfter !== withdrawn) throw new Error("pool debit mismatch");

  const spent = await simulateRead(operator, poolId, "is_spent", [bytesScVal(toBE32(nullifierHash))]);
  if (spent !== true) throw new Error("nullifier should be spent");

  console.log("• Asserting direct nullifier replay is rejected…");
  let replayRejected = false;
  try {
    await invoke(operator, poolId, "withdraw", [
      bytesScVal(a), bytesScVal(b), bytesScVal(c), i128ScVal(withdrawn),
      bytesScVal(toBE32(state.root)), bytesScVal(toBE32(asp.root)),
      bytesScVal(toBE32(nullifierHash)), bytesScVal(toBE32(newCommitment)),
      new Address(recipient.publicKey()).toScVal(), i128ScVal(poolFee),
      new Address(registryId).toScVal(),
    ]);
  } catch {
    replayRejected = true;
  }
  if (!replayRejected) throw new Error("nullifier replay should have been rejected");

  console.log("\nOK: smoke:pool:relayer passed - proof withdrawal submitted by relayer registry");
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n✗ ${e?.message ?? e}`);
  process.exit(1);
});
