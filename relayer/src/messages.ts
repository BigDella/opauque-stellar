import { Keypair } from "@stellar/stellar-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import { Buffer } from "buffer";
import { assertLength, base64ToBytes, bytesToBase64, bytesToHex, concatBytes, hexToBytes } from "./shared/bytes.ts";
import { RELAY_CHAIN_STELLAR } from "./shared/payload.ts";

const BID_DOMAIN = new TextEncoder().encode("opaque-relayer-bid-v2");

export type JobAdvert = {
  t: "advert";
  v: 1;
  jobId: string;
  chain: number;
  fee: string;
  deadline: number;
  payloadHash: string;
};

export type RelayerBid = {
  t: "bid";
  v: 1;
  jobId: string;
  chain: number;
  operator: string;
  x25519Pk: string;
  sig: string;
  endpoint?: string;
  freeStake?: string;
};

export type EncryptedPayload = {
  t: "payload";
  v: 1;
  jobId: string;
  to: string;
  box: string;
  idempotencyKey?: string;
};

/** Reported by a relayer node once a job it accepted has resolved, good or bad. */
export type RelayerOutcome = {
  t: "outcome";
  v: 1;
  jobId: string;
  operator: string;
  result: "completed" | "failed";
};

/** Periodic liveness ping a relayer node gossips so the hub can detect an outage. */
export type RelayerHeartbeat = {
  t: "heartbeat";
  v: 1;
  operator: string;
};

export type RelayerMessage =
  | JobAdvert
  | RelayerBid
  | EncryptedPayload
  | RelayerOutcome
  | RelayerHeartbeat;

export function validateRelayerMessage(value: unknown): RelayerMessage {
  const v = value as { t?: unknown };
  if (v?.t === "advert") return validateAdvert(value);
  if (v?.t === "bid") return validateBid(value);
  if (v?.t === "payload") return validatePayload(value);
  if (v?.t === "outcome") return validateOutcome(value);
  if (v?.t === "heartbeat") return validateHeartbeat(value);
  throw new Error("Invalid relayer message.");
}

export function makeAdvert(args: {
  jobId: Uint8Array;
  fee: bigint;
  deadline: number;
  payloadHash: Uint8Array;
  chain?: number;
}): JobAdvert {
  return {
    t: "advert",
    v: 1,
    jobId: bytesToHex(assertLength(args.jobId, 32, "jobId")),
    chain: args.chain ?? RELAY_CHAIN_STELLAR,
    fee: args.fee.toString(),
    deadline: args.deadline,
    payloadHash: bytesToHex(assertLength(args.payloadHash, 32, "payloadHash")),
  };
}

/**
 * Encode a uint32 as 4 big-endian bytes.
 */
function uint32BE(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n >>> 0, false);
  return buf;
}

/**
 * Encode a uint64 (bigint) as 8 big-endian bytes.
 */
function uint64BE(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, Number((n >> 32n) & 0xffff_ffffn), false);
  view.setUint32(4, Number(n & 0xffff_ffffn), false);
  return buf;
}

/**
 * Length-prefix a UTF-8 string as uint16 + bytes so different endpoint values
 * cannot produce the same serialisation.
 */
function lengthPrefixedUtf8(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, enc.length, false);
  return concatBytes(len, enc);
}

/**
 * Canonical signed digest for a relayer bid (v2).
 *
 * Covers every field that influences bid selection so a hub or network
 * intermediary cannot rewrite endpoint, freeStake, or chain without
 * invalidating the signature:
 *
 *   keccak256(DOMAIN || jobId[32] || x25519Pk[32] || chain[4] ||
 *             endpointLen[2] || endpoint[*] || freeStake[8])
 *
 * `endpoint` defaults to the empty string when absent.
 * `freeStake` defaults to 0 when absent.
 */
export function bidSigningDigest(
  jobId: Uint8Array,
  x25519Pk: Uint8Array,
  chain: number,
  endpoint: string,
  freeStake: bigint,
): Uint8Array {
  return keccak_256(
    concatBytes(
      BID_DOMAIN,
      assertLength(jobId, 32, "jobId"),
      assertLength(x25519Pk, 32, "x25519Pk"),
      uint32BE(chain),
      lengthPrefixedUtf8(endpoint),
      uint64BE(freeStake),
    ),
  );
}

export function makeBid(args: {
  advert: JobAdvert;
  operator: Keypair;
  x25519Pk: Uint8Array;
  endpoint?: string;
  freeStake?: bigint;
}): RelayerBid {
  const x25519Pk = assertLength(args.x25519Pk, 32, "x25519Pk");
  const endpoint = args.endpoint ?? "";
  const freeStake = args.freeStake ?? 0n;
  const digest = bidSigningDigest(
    hexToBytes(args.advert.jobId),
    x25519Pk,
    args.advert.chain,
    endpoint,
    freeStake,
  );
  return {
    t: "bid",
    v: 1,
    jobId: args.advert.jobId,
    chain: args.advert.chain,
    operator: args.operator.publicKey(),
    x25519Pk: bytesToHex(x25519Pk),
    sig: bytesToBase64(args.operator.sign(Buffer.from(digest))),
    endpoint: args.endpoint,
    freeStake: args.freeStake?.toString(),
  };
}

export function verifyBid(bid: RelayerBid): boolean {
  try {
    const digest = bidSigningDigest(
      hexToBytes(bid.jobId),
      hexToBytes(bid.x25519Pk),
      bid.chain ?? 0,
      bid.endpoint ?? "",
      bid.freeStake !== undefined ? BigInt(bid.freeStake) : 0n,
    );
    return Keypair.fromPublicKey(bid.operator).verify(
      Buffer.from(digest),
      Buffer.from(base64ToBytes(bid.sig)),
    );
  } catch {
    return false;
  }
}

export function validateAdvert(value: unknown): JobAdvert {
  const v = value as Partial<JobAdvert>;
  if (
    v?.t !== "advert" ||
    v.v !== 1 ||
    typeof v.jobId !== "string" ||
    typeof v.payloadHash !== "string" ||
    typeof v.fee !== "string" ||
    typeof v.deadline !== "number"
  ) {
    throw new Error("Invalid relayer advert.");
  }
  assertLength(hexToBytes(v.jobId), 32, "jobId");
  assertLength(hexToBytes(v.payloadHash), 32, "payloadHash");
  return { ...v, chain: v.chain ?? RELAY_CHAIN_STELLAR } as JobAdvert;
}

export function validateBid(value: unknown): RelayerBid {
  const v = value as Partial<RelayerBid>;
  if (
    v?.t !== "bid" ||
    v.v !== 1 ||
    typeof v.jobId !== "string" ||
    typeof v.operator !== "string" ||
    typeof v.x25519Pk !== "string" ||
    typeof v.sig !== "string"
  ) {
    throw new Error("Invalid relayer bid.");
  }
  assertLength(hexToBytes(v.jobId), 32, "jobId");
  assertLength(hexToBytes(v.x25519Pk), 32, "x25519Pk");
  return { ...v, chain: v.chain ?? RELAY_CHAIN_STELLAR } as RelayerBid;
}

export function validateOutcome(value: unknown): RelayerOutcome {
  const v = value as Partial<RelayerOutcome>;
  if (
    v?.t !== "outcome" ||
    v.v !== 1 ||
    typeof v.jobId !== "string" ||
    typeof v.operator !== "string" ||
    (v.result !== "completed" && v.result !== "failed")
  ) {
    throw new Error("Invalid relayer outcome.");
  }
  assertLength(hexToBytes(v.jobId), 32, "jobId");
  return v as RelayerOutcome;
}

export function validateHeartbeat(value: unknown): RelayerHeartbeat {
  const v = value as Partial<RelayerHeartbeat>;
  if (v?.t !== "heartbeat" || v.v !== 1 || typeof v.operator !== "string") {
    throw new Error("Invalid relayer heartbeat.");
  }
  return v as RelayerHeartbeat;
}

export function validatePayload(value: unknown): EncryptedPayload {
  const v = value as Partial<EncryptedPayload>;
  if (
    v?.t !== "payload" ||
    v.v !== 1 ||
    typeof v.jobId !== "string" ||
    typeof v.to !== "string" ||
    typeof v.box !== "string"
  ) {
    throw new Error("Invalid relayer payload.");
  }
  assertLength(hexToBytes(v.jobId), 32, "jobId");
  assertLength(hexToBytes(v.to), 32, "payload recipient");
  return v as EncryptedPayload;
}
