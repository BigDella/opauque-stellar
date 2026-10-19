/**
 * Headless end-to-end smoke test for the Opaque Stellar private-payment flow.
 *
 *   register meta-address -> send stealth XLM -> scan announcements -> sweep
 *
 * It runs against the deployed testnet contracts (read from
 * deployments/v1/testnet.json) using raw Stellar Keypairs instead of Freighter,
 * and reuses the real, framework-free crypto:
 *   - DKSAP derivation from src/lib/stealth.ts
 *   - the Rust WASM scanner from public/pkg/opauque_scanner.js
 *
 * This proves the private payment works end to end without a browser, and serves
 * as groundwork for the Phase 6 SDK signer abstraction.
 *
 * Run:  cd frontend && npx tsx scripts/smoke-private-payment.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  Keypair,
  Contract,
  TransactionBuilder,
  Operation,
  Address,
  Horizon,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
  BASE_FEE,
} from "@stellar/stellar-sdk";

import {
  deriveKeysFromSignature,
  keysToStealthMetaAddress,
  stealthMetaAddressToHex,
  computeStealthAddressAndViewTag,
  deriveStealthStellarKeypairFromStealthPrivKey,
  hexToBytes,
  bytesToHex,
} from "../src/lib/stealth.ts";

import initWasm, {
  check_announcement_view_tag_wasm,
  check_announcement_wasm,
  reconstruct_signing_key_wasm,
} from "../public/pkg/opauque_scanner.js";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON_URL = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const FRIENDBOT = "https://friendbot.stellar.org";
const SCHEME_ID = 1n; // secp256k1
const SEND_AMOUNT_XLM = "5";

const manifest = JSON.parse(
  readFileSync(join(REPO_ROOT, "deployments", "v1", "testnet.json"), "utf8"),
);
if (manifest.deploymentStatus !== "deployed") {
  throw new Error(`testnet manifest is "${manifest.deploymentStatus}", expected "deployed"`);
}
const REGISTRY_ID = manifest.contracts.stealthRegistry.id;
const ANNOUNCER_ID = manifest.contracts.stealthAnnouncer.id;

const server = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let step = 0;
function log(msg: string) {
  console.log(`\n[${++step}] ${msg}`);
}
function detail(msg: string) {
  console.log(`    ${msg}`);
}

const u64 = (v: bigint) => nativeToScVal(v, { type: "u64" });
const addr = (pub: string) => new Address(pub).toScVal();
const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));

async function fund(pub: string) {
  const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot funding failed (${res.status}) for ${pub}`);
  await res.json();
}

async function nativeBalance(pub: string): Promise<number> {
  const acct = await horizon.loadAccount(pub);
  const b = acct.balances.find((x: any) => x.asset_type === "native");
  return b ? Number(b.balance) : 0;
}

async function submit(tx: any, label: string): Promise<any> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`${label}: send rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }
  const hash = sent.hash;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const r = await server.getTransaction(hash);
    if (r.status === "SUCCESS") {
      detail(`${label} ✓ ${hash} (ledger ${r.ledger})`);
      return r;
    }
    if (r.status === "FAILED") {
      throw new Error(`${label}: tx FAILED ${hash}`);
    }
    // NOT_FOUND -> still being applied; keep polling
  }
  throw new Error(`${label}: tx not confirmed after timeout: ${hash}`);
}

/** Build, prepare, sign, and submit a Soroban contract invocation. */
async function invoke(sourceKp: any, contractId: string, method: string, args: any[], label: string) {
  const acct = await server.getAccount(sourceKp.publicKey());
  const op = new Contract(contractId).call(method, ...args);
  let tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(sourceKp);
  return submit(tx, label);
}

/** Build, sign, and submit a classic (non-Soroban) operation. */
async function classic(sourceKp: any, operation: any, label: string) {
  const acct = await server.getAccount(sourceKp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  tx.sign(sourceKp);
  return submit(tx, label);
}

/** Decode an rpc getEvents `value` (base64 string | {xdr} | xdr.ScVal) to native JS. */
function decodeEventValue(value: any): any {
  if (value == null) return null;
  if (typeof value === "string") return scValToNative(xdr.ScVal.fromXDR(value, "base64"));
  if (typeof value === "object" && typeof value.xdr === "string") {
    return scValToNative(xdr.ScVal.fromXDR(value.xdr, "base64"));
  }
  return scValToNative(value);
}

// -----------------------------------------------------------------------------
// Main flow
// -----------------------------------------------------------------------------
async function main() {
  console.log("Opaque Stellar — private payment smoke test (testnet)");
  console.log(`  registry:  ${REGISTRY_ID}`);
  console.log(`  announcer: ${ANNOUNCER_ID}`);

  // --- 0. accounts ---
  const sender = Keypair.random();
  const recipient = Keypair.random(); // recipient's main Stellar account (registrant + sweep dest)
  log("Funding sender + recipient via friendbot…");
  await Promise.all([fund(sender.publicKey()), fund(recipient.publicKey())]);
  detail(`sender:    ${sender.publicKey()}`);
  detail(`recipient: ${recipient.publicKey()}`);

  // --- 1. recipient derives + registers a stealth meta-address ---
  log("Recipient derives stealth keys and registers meta-address…");
  const entropy = "0x" + randomBytes(64).toString("hex"); // stands in for a wallet signature
  const { viewingKey, spendingKey } = deriveKeysFromSignature(entropy);
  const { S: spendPubKey, metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
  const metaHex = stealthMetaAddressToHex(metaAddress);
  detail(`meta-address (66B): ${metaHex.slice(0, 20)}…`);
  await invoke(
    recipient,
    REGISTRY_ID,
    "register_keys",
    [addr(recipient.publicKey()), u64(SCHEME_ID), bytes(metaAddress)],
    "register_keys",
  );

  // --- 2. sender derives a one-time stealth address + announces + funds it ---
  log("Sender derives one-time stealth address and announces it…");
  const stealth = computeStealthAddressAndViewTag(metaHex);
  const stealthIdBytes = hexToBytes(stealth.stealthAddress.slice(2)); // 20-byte keccak id
  detail(`stealth id:        ${stealth.stealthAddress}`);
  detail(`stealth account:   ${stealth.stealthStellarAddress}`);
  detail(`view tag:          ${stealth.viewTag}`);
  const announceRes = await invoke(
    sender,
    ANNOUNCER_ID,
    "announce",
    [
      addr(sender.publicKey()),
      u64(SCHEME_ID),
      bytes(stealthIdBytes),
      bytes(stealth.ephemeralPubKey),
      bytes(stealth.metadata),
    ],
    "announce",
  );
  const announceLedger = Number(announceRes.ledger);

  log(`Sender funds the stealth account with ${SEND_AMOUNT_XLM} XLM (createAccount)…`);
  await classic(
    sender,
    Operation.createAccount({
      destination: stealth.stealthStellarAddress,
      startingBalance: SEND_AMOUNT_XLM,
    }),
    "createAccount",
  );

  // --- 3. recipient scans announcements (WASM view-tag filter + key reconstruct) ---
  log("Recipient scans announcer events with the WASM scanner…");
  await initWasm({ module_or_path: readFileSync(join(REPO_ROOT, "frontend", "public", "pkg", "opauque_scanner_bg.wasm")) });

  let recovered: { stellarAddress: string; stealthPriv: Uint8Array } | null = null;
  let cursor: string | undefined;
  let scanned = 0;
  for (let page = 0; page < 20 && !recovered; page++) {
    const res = await server.getEvents(
      cursor
        ? { filters: [{ type: "contract", contractIds: [ANNOUNCER_ID] }], limit: 100, cursor }
        : { filters: [{ type: "contract", contractIds: [ANNOUNCER_ID] }], limit: 100, startLedger: announceLedger },
    );
    for (const ev of res.events ?? []) {
      scanned++;
      const data = decodeEventValue(ev.value);
      if (!Array.isArray(data) || data.length < 5) continue;
      const schemeId = BigInt(data[0]);
      if (schemeId !== SCHEME_ID) continue;
      const evStealthId = Uint8Array.from(data[1]);
      const evEphemeral = Uint8Array.from(data[3]);
      const evMetadata = Uint8Array.from(data[4]);
      if (evEphemeral.length !== 33) continue;
      const viewTag = evMetadata.length > 0 ? evMetadata[0] : 0;
      const stealthIdHex = "0x" + bytesToHex(evStealthId);

      if (check_announcement_view_tag_wasm(viewTag, viewingKey, evEphemeral) === "NoMatch") continue;
      if (!check_announcement_wasm(stealthIdHex, viewTag, viewingKey, spendPubKey, evEphemeral)) continue;

      const stealthPriv = reconstruct_signing_key_wasm(spendingKey, viewingKey, evEphemeral);
      const kp = deriveStealthStellarKeypairFromStealthPrivKey(stealthPriv);
      recovered = { stellarAddress: kp.publicKey(), stealthPriv };
      break;
    }
    if (!res.cursor || (res.events ?? []).length < 100) break;
    cursor = res.cursor;
    await sleep(200);
  }
  detail(`scanned ${scanned} announcement(s)`);

  if (!recovered) throw new Error("SCAN FAILED: recipient did not detect the stealth payment");
  detail(`recovered stealth account: ${recovered.stellarAddress}`);
  if (recovered.stellarAddress !== stealth.stealthStellarAddress) {
    throw new Error(
      `MISMATCH: scanned account ${recovered.stellarAddress} != sender-derived ${stealth.stealthStellarAddress}`,
    );
  }
  detail("✓ scanned account matches the sender-derived stealth account");

  // --- 4. recipient sweeps the stealth account to their main account ---
  const before = await nativeBalance(recipient.publicKey());
  log(`Recipient sweeps the stealth account (balance before: ${before} XLM)…`);
  const stealthKp = deriveStealthStellarKeypairFromStealthPrivKey(recovered.stealthPriv);
  await classic(
    stealthKp,
    Operation.accountMerge({ destination: recipient.publicKey() }),
    "accountMerge (sweep)",
  );
  const after = await nativeBalance(recipient.publicKey());
  const delta = after - before;
  detail(`recipient balance after: ${after} XLM (Δ +${delta.toFixed(4)})`);
  if (delta < Number(SEND_AMOUNT_XLM) - 1) {
    throw new Error(`SWEEP FAILED: expected ~${SEND_AMOUNT_XLM} XLM increase, got ${delta}`);
  }

  console.log("\n✅ SMOKE TEST PASSED — register → send → scan → sweep all succeeded on testnet.");
}

main().catch((err) => {
  console.error(`\n❌ SMOKE TEST FAILED: ${err?.message ?? err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
