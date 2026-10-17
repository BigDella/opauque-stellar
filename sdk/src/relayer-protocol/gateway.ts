/**
 * Relayer-market gateway client: build a blind withdrawal payload, advertise a
 * job, collect and verify bids (signature + on-chain registry state), pick a
 * relayer, and deliver the payload encrypted to its X25519 key. HTTP transport
 * is the `opaque/jobs/v1` gateway API.
 *
 * Every gateway request enforces a configurable timeout, supports caller-initiated
 * abort via `AbortSignal`, and fails over across configured gateway URLs with
 * linear-backoff retry on transient failures.
 */
import type { ContractInvoker } from "../rpc/client";
import { GatewayError } from "../errors";
import { addressToScVal, bytesToScVal } from "../rpc/scval";
import type { PoolWithdrawProof } from "../prove/pool";
import { sealBox } from "./box";
import {
  makeAdvert,
  validateBid,
  verifyBid,
  type JobAdvert,
  type RelayerBid,
} from "./messages";
import { assertLength, bytesToHex, hexToBytes } from "./bytes";
import {
  encodePoolWithdrawPayload,
  hashPoolWithdrawPayload,
  RELAY_CHAIN_STELLAR,
  type PoolWithdrawPayload,
} from "./payload";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifiedBid = RelayerBid & { freeStakeValue: bigint };

export type RelayerJobDraft = {
  jobId: Uint8Array;
  jobIdHex: string;
  payload: PoolWithdrawPayload;
  payloadHash: Uint8Array;
  payloadHashHex: string;
  advert: JobAdvert;
  deadlineLedger: number;
  fee: bigint;
};

export type RelayerJobStatus =
  | "open"
  | "accepted"
  | "submitted"
  | "slashed"
  | "canceled"
  | "unknown";

/** Options for individual gateway HTTP requests. */
export type GatewayRequestOptions = {
  /** Caller-provided abort signal. Composed with the per-request timeout. */
  signal?: AbortSignal;
  /** Per-request timeout in ms. Overrides the constructor default. */
  timeoutMs?: number;
  /** Override the gateway URL for this request. */
  gateway?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-request timeout for gateway HTTP calls. */
export const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;

/** Default number of gateway failover attempts per request. */
const DEFAULT_RETRIES = 2;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const REGISTRY_JOB_STATUS: Record<number, RelayerJobStatus> = {
  0: "open",
  1: "accepted",
  2: "submitted",
  3: "slashed",
  4: "canceled",
};

type NativeRegistryJob = { status: number | bigint; fee: bigint | number | string };
type NativeRegistryRelayer = {
  endpoint?: string;
  free_stake: bigint | number | string;
  x25519_pubkey: Uint8Array | number[];
};

/**
 * Combine a caller-provided abort signal with a timeout into a single signal.
 * Returns `{ signal, timedOut }` — the caller can inspect `timedOut` after a
 * failure to distinguish timeout-induced aborts from caller-initiated ones.
 */
function combineSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean } {
  let timedOut = false;

  if (typeof AbortSignal.timeout === "function") {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    timeoutSignal.addEventListener("abort", () => { timedOut = true; }, { once: true });
    const signals: AbortSignal[] = [timeoutSignal];
    if (callerSignal) signals.push(callerSignal);
    return { signal: AbortSignal.any(signals), timedOut: () => timedOut };
  }

  // Fallback for environments without AbortSignal.timeout / AbortSignal.any.
  const controller = new AbortController();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cleanup = () => { clearTimeout(timer); };
  if (callerSignal) {
    if (callerSignal.aborted) {
      cleanup();
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", () => {
        cleanup();
        controller.abort(callerSignal.reason);
      }, { once: true });
    }
  }
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return { signal: controller.signal, timedOut: () => timedOut };
}

function isRetryableGatewayStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Cryptographically random 32-byte job id. */
export function randomJobId(): Uint8Array {
  const out = new Uint8Array(32);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * Build the blind withdrawal payload. The pool fee is zero (the registry escrow
 * pays the relayer) and the proof binds the registry as the pool relayer, so the
 * payload hash is deterministic before a relayer is chosen.
 */
export function buildRelayedWithdrawPayload(args: {
  poolId: string;
  registryId: string;
  proof: PoolWithdrawProof;
  recipient: string;
}): PoolWithdrawPayload {
  return {
    poolId: args.poolId,
    proofA: args.proof.proofA,
    proofB: args.proof.proofB,
    proofC: args.proof.proofC,
    withdrawnValue: args.proof.withdrawnValue,
    stateRoot: args.proof.stateRoot,
    aspRoot: args.proof.aspRoot,
    nullifierHash: args.proof.nullifierHash,
    newCommitment: args.proof.newCommitment,
    recipient: args.recipient,
    poolFee: 0n,
    poolRelayer: args.registryId,
  };
}

export function buildRelayerJobDraft(args: {
  payload: PoolWithdrawPayload;
  fee: bigint;
  deadlineLedger: number;
  jobId?: Uint8Array;
}): RelayerJobDraft {
  const jobId = assertLength(args.jobId ?? randomJobId(), 32, "jobId");
  const payloadHash = hashPoolWithdrawPayload(args.payload);
  return {
    jobId,
    jobIdHex: bytesToHex(jobId),
    payload: args.payload,
    payloadHash,
    payloadHashHex: bytesToHex(payloadHash),
    advert: makeAdvert({ jobId, fee: args.fee, deadline: args.deadlineLedger, payloadHash }),
    deadlineLedger: args.deadlineLedger,
    fee: args.fee,
  };
}

/** Stake-weighted random choice among verified bids. */
export function pickStakeWeightedBid(bids: VerifiedBid[]): VerifiedBid | null {
  if (bids.length === 0) return null;
  const total = bids.reduce((sum, bid) => sum + bid.freeStakeValue, 0n);
  if (total <= 0n) return bids[0];
  const rand = new Uint32Array(2);
  globalThis.crypto.getRandomValues(rand);
  let target = ((BigInt(rand[0]) << 32n) + BigInt(rand[1])) % total;
  for (const bid of bids) {
    if (target < bid.freeStakeValue) return bid;
    target -= bid.freeStakeValue;
  }
  return bids[bids.length - 1];
}

// ---------------------------------------------------------------------------
// RelayerGateway
// ---------------------------------------------------------------------------

export class RelayerGateway {
  private readonly gatewayUrls: string[];
  private readonly registryId: string;
  private readonly invoker: ContractInvoker;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(opts: {
    gatewayUrls: string[];
    registryId: string;
    invoker: ContractInvoker;
    /** Per-request timeout in ms (default: {@link DEFAULT_GATEWAY_TIMEOUT_MS}). */
    timeoutMs?: number;
    /** Number of failover attempts across gateways (default: 2). */
    retries?: number;
  }) {
    if (opts.gatewayUrls.length === 0) {
      throw new Error("RelayerGateway requires at least one gateway URL.");
    }
    this.gatewayUrls = opts.gatewayUrls;
    this.registryId = opts.registryId;
    this.invoker = opts.invoker;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
  }

  private url(path: string, base = this.gatewayUrls[0]): string {
    return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
  }

  /** A deadline `ledgers` ahead of the current ledger. */
  async deadlineLedger(ledgers = 720): Promise<number> {
    return (await this.invoker.getLatestLedger()) + ledgers;
  }

  // --- gateway HTTP with timeout, abort, failover, retry -------------------

  /**
   * Fetch across configured gateways with per-request timeout, caller abort
   * support, and linear-backoff retry on transient failures.  Returns the
   * parsed JSON body.  Throws {@link GatewayError} on exhausted retries or
   * non-retryable failures.
   */
  private async gatewayFetch<T = unknown>(
    path: string,
    init: RequestInit,
    opts?: GatewayRequestOptions,
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    // maxAttempts = retries + 1: retries:0 means exactly one attempt, retries:2
    // means one initial attempt plus two retries (three total). With a single
    // gateway URL the old `Math.min(retries, urls.length)` formula yielded
    // maxAttempts=1, making the documented linear-backoff retry never happen
    // (issue #1008); the +1 form keeps the attempt budget independent of URL count.
    const maxAttempts = this.retries + 1;
    const callerSignal = opts?.signal;

    if (callerSignal?.aborted) {
      throw new GatewayError("Gateway request aborted by caller", {
        cause: callerSignal.reason,
      });
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const gateway =
        attempt === 0 && opts?.gateway
          ? opts.gateway
          : this.gatewayUrls[attempt % this.gatewayUrls.length];
      const { signal, timedOut } = combineSignal(callerSignal, timeoutMs);

      try {
        const res = await fetch(this.url(path, gateway), { ...init, signal });

        if (!res.ok) {
          if (isRetryableGatewayStatus(res.status) && attempt + 1 < maxAttempts) {
            await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
            continue;
          }
          throw new GatewayError(
            `Relayer gateway returned ${res.status} from ${gateway}`,
            { httpStatus: res.status, gatewayUrl: gateway },
          );
        }

        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof GatewayError) throw err;

        if (isAbortError(err) || (err instanceof TypeError && /fetch/i.test(err.message))) {
          if (callerSignal?.aborted && !timedOut()) {
            throw new GatewayError("Gateway request aborted by caller", {
              cause: callerSignal.reason ?? err,
            });
          }
          lastError = err;
          if (attempt + 1 < maxAttempts) {
            await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
            continue;
          }
        }
        throw new GatewayError(
          `Gateway request failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    throw new GatewayError(
      `All ${maxAttempts} gateway(s) failed for ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { cause: lastError },
    );
  }

  // --- public API ----------------------------------------------------------

  async publishAdvert(
    advert: JobAdvert,
    opts?: GatewayRequestOptions,
  ): Promise<void> {
    await this.gatewayFetch("v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(advert),
    }, opts);
  }

  async fetchBids(
    jobIdHex: string,
    opts?: GatewayRequestOptions,
  ): Promise<VerifiedBid[]> {
    const body = await this.gatewayFetch<{ bids?: unknown[] }>(
      `v1/jobs/${encodeURIComponent(jobIdHex)}/bids`,
      {},
      opts,
    );
    const signed = (body.bids ?? [])
      .map((raw) => validateBid(raw))
      .filter((bid) => verifyBid(bid))
      .filter((bid) => bid.jobId.toLowerCase() === jobIdHex.toLowerCase())
      .filter((bid) => bid.chain === RELAY_CHAIN_STELLAR);
    const checked = await Promise.all(signed.map((bid) => this.verifyBidRegistryState(jobIdHex, bid)));
    return checked.filter((bid): bid is VerifiedBid => bid !== null);
  }

  async deliverPayload(args: {
    draft: RelayerJobDraft;
    bid: RelayerBid;
    gateway?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{ acceptedTx?: string; submittedTx?: string } | null> {
    const box = await sealBox(
      encodePoolWithdrawPayload(args.draft.payload),
      hexToBytes(args.bid.x25519Pk),
    );
    // Stable idempotency key: jobId + relayer x25519 pubkey uniquely identify
    // one delivery attempt. The same key is sent on every retry so the relayer
    // can de-duplicate re-POSTs that arrive after a gateway timeout.
    const idempotencyKey = `${args.draft.jobIdHex}:${args.bid.x25519Pk}`;
    const body = await this.gatewayFetch<{
      result?: { acceptedTx?: string; submittedTx?: string } | null;
    }>(
      `v1/jobs/${encodeURIComponent(args.draft.jobIdHex)}/payload`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ t: "payload", v: 1, jobId: args.draft.jobIdHex, to: args.bid.x25519Pk, box }),
      },
      { gateway: args.gateway, signal: args.signal, timeoutMs: args.timeoutMs },
    );
    return body.result ?? null;
  }

  async jobStatus(jobIdHex: string, source: string): Promise<RelayerJobStatus> {
    const job = await this.registryView<NativeRegistryJob>(source, "get_job", [
      bytesToScVal(hexToBytes(jobIdHex)),
    ]);
    if (!job) return "unknown";
    return REGISTRY_JOB_STATUS[Number(job.status)] ?? "unknown";
  }

  // --- internal -----------------------------------------------------------

  private async verifyBidRegistryState(
    jobIdHex: string,
    bid: RelayerBid,
  ): Promise<VerifiedBid | null> {
    try {
      const [job, relayer] = await Promise.all([
        this.registryView<NativeRegistryJob>(bid.operator, "get_job", [
          bytesToScVal(hexToBytes(jobIdHex)),
        ]),
        this.registryView<NativeRegistryRelayer>(bid.operator, "get_relayer", [
          addressToScVal(bid.operator),
        ]),
      ]);
      if (!job || !relayer) return null;
      const fee = BigInt(job.fee);
      const freeStakeValue = BigInt(relayer.free_stake);
      if (Number(job.status) !== 0 || freeStakeValue < fee) return null;
      const registeredPk = bytesToHex(Uint8Array.from(relayer.x25519_pubkey));
      if (registeredPk.toLowerCase() !== bid.x25519Pk.toLowerCase()) return null;
      return {
        ...bid,
        endpoint: relayer.endpoint?.trim() || bid.endpoint,
        freeStake: freeStakeValue.toString(),
        freeStakeValue,
      };
    } catch {
      return null;
    }
  }

  private async registryView<T>(
    source: string,
    method: string,
    args: Parameters<ContractInvoker["readNative"]>[0]["args"],
  ): Promise<T | null> {
    try {
      return await this.invoker.readNative<T>({
        source,
        contractId: this.registryId,
        method,
        args,
      });
    } catch {
      return null;
    }
  }
}
