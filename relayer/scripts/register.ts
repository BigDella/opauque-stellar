/**
 * Register or top up a relayer in the on-chain registry.
 *
 * Required:
 *   RELAYER_OPERATOR_SECRET=S...
 *   RELAYER_X25519_SECRET=<32-byte hex seed>
 * Optional:
 *   RELAYER_ENDPOINT=https://relay.example
 *   RELAYER_STAKE=1000000
 *   RELAYER_REGISTRY_ID=...
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { generateX25519Keypair } from "../src/shared/box.ts";
import { bytesToHex, hexToBytes } from "../src/shared/bytes.ts";
import testnetManifest from "../../deployments/v1/testnet.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

function bytesScVal(bytes: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

async function simulate(
  server: rpc.Server,
  source: string,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown | null> {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
  return scValToNative(sim.result.retval);
}

async function invoke(
  server: rpc.Server,
  signer: Keypair,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  const account = await server.getAccount(signer.publicKey());
  let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(180)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(signer);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`${method} rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return sent.hash;
    if (result.status === "FAILED") throw new Error(`${method} failed: ${sent.hash}`);
  }
  throw new Error(`${method} not confirmed: ${sent.hash}`);
}

loadDotEnv();

const manifest = testnetManifest as {
  rpcUrl: string;
  networkPassphrase: string;
  contracts: { relayerRegistry?: { id?: string | null } };
  wiring?: { relayerRegistry?: { minimumStake?: number | string } };
};
const registryId = process.env.RELAYER_REGISTRY_ID?.trim() || manifest.contracts.relayerRegistry?.id;
if (!registryId) throw new Error("Set RELAYER_REGISTRY_ID or deploy relayerRegistry in the testnet manifest.");

const operator = Keypair.fromSecret(required("RELAYER_OPERATOR_SECRET"));
const x25519 = generateX25519Keypair(hexToBytes(required("RELAYER_X25519_SECRET")));
const endpoint = process.env.RELAYER_ENDPOINT?.trim() || "http://127.0.0.1:8787";
const stake = BigInt(process.env.RELAYER_STAKE ?? manifest.wiring?.relayerRegistry?.minimumStake ?? 1_000_000);
const rpcUrl = process.env.STELLAR_RPC_URL?.trim() || manifest.rpcUrl;
const networkPassphrase = process.env.NETWORK_PASSPHRASE?.trim() || manifest.networkPassphrase;
const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

const operatorAddress = operator.publicKey();
const x25519Hex = bytesToHex(x25519.publicKey);
console.log(`registry=${registryId}`);
console.log(`operator=${operatorAddress}`);
console.log(`x25519=${x25519Hex}`);
console.log(`endpoint=${endpoint}`);

const relayer = await simulate(server, operatorAddress, networkPassphrase, registryId, "get_relayer", [
  nativeToScVal(operatorAddress, { type: "address" }),
]) as { x25519_pubkey?: Uint8Array; free_stake?: bigint | number | string } | null;

if (!relayer) {
  console.log(`registering with stake=${stake}`);
  const hash = await invoke(server, operator, networkPassphrase, registryId, "register", [
    new Address(operatorAddress).toScVal(),
    bytesScVal(x25519.publicKey),
    nativeToScVal(endpoint, { type: "string" }),
    nativeToScVal(stake, { type: "i128" }),
  ]);
  console.log(`registered tx=${hash}`);
} else {
  const registeredPk = bytesToHex(Uint8Array.from(relayer.x25519_pubkey ?? []));
  const freeStake = BigInt(relayer.free_stake ?? 0);
  console.log(`already registered freeStake=${freeStake}`);
  if (registeredPk.toLowerCase() !== x25519Hex.toLowerCase()) {
    throw new Error(`registered X25519 key ${registeredPk} does not match running key ${x25519Hex}`);
  }
  if (freeStake < stake) {
    const topUp = stake - freeStake;
    console.log(`adding stake=${topUp}`);
    const hash = await invoke(server, operator, networkPassphrase, registryId, "add_stake", [
      new Address(operatorAddress).toScVal(),
      nativeToScVal(topUp, { type: "i128" }),
    ]);
    console.log(`stake added tx=${hash}`);
  }
}
