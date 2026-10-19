/**
 * Typed client for the reputation-root publisher service
 * (`config.reputationPublisherUrl`). Submits Merkle leaf commitments and fetches
 * the inclusion path + root for a leaf, so reputation proofs can use real
 * published Merkle paths. HTTP failures map to {@link PublisherError} (or
 * {@link RootUnavailableError} for a leaf the published root doesn't cover yet).
 */
import { ConfigError, PublisherError, RootUnavailableError } from "../errors/index";

/** A leaf commitment to queue for the next published root. */
export interface PublisherLeafSubmission {
  /** V2 Merkle leaf commitment as 0x-prefixed 32-byte hex. */
  leaf: string;
  /** Stable dedupe id; defaults to `attestationUid` on the publisher side. */
  id?: string;
  /** Optional schema id as 0x-prefixed 32-byte hex. */
  schemaId?: string;
  /** Optional attestation UID as 0x-prefixed 32-byte hex. */
  attestationUid?: string;
  /** Source transaction hash, if available. */
  txHash?: string;
  /** Ledger containing the related attestation. */
  ledger?: number;
}

export interface PublisherSubmitResult {
  queued: boolean;
  inboxDepth: number;
  accepted: PublisherLeafSubmission & { id: string };
}

/** A leaf's inclusion path against the publisher's current root. */
export interface PublisherInclusionPath {
  verifierId: string;
  leaf: string;
  leafIndex: number;
  leafCount: number;
  root: string;
  datasetHash: string;
  pathElements: string[];
  pathIndices: number[];
}

export interface PublisherSnapshot {
  snapshot: unknown;
  snapshotHash: string;
}

export interface PublisherClientOptions {
  /** Publisher base URL (e.g. `https://publisher.example.com`). */
  baseUrl: string;
  /** Bearer token for `POST /v1/reputation/leaves` when the publisher requires auth. */
  submitToken?: string;
  /** Per-request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
  /** Injected fetch (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class PublisherClient {
  private readonly baseUrl: string;
  private readonly submitToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PublisherClientOptions) {
    if (!opts.baseUrl) {
      throw new ConfigError(
        "No reputation publisher URL configured. Set config.reputationPublisherUrl.",
      );
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.submitToken = opts.submitToken;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new ConfigError("No fetch implementation available; pass opts.fetch.");
    this.fetchImpl = f.bind(globalThis);
  }

  /** Queue a leaf commitment for inclusion in the next published root. */
  async submitLeaf(leaf: PublisherLeafSubmission): Promise<PublisherSubmitResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.submitToken) headers.authorization = `Bearer ${this.submitToken}`;
    const body = await this.request("/v1/reputation/leaves", {
      method: "POST",
      headers,
      body: JSON.stringify(leaf),
    });
    if (!isRecord(body) || body.ok !== true || !isRecord(body.accepted)) {
      throw badResponse("submitLeaf");
    }
    return {
      queued: body.queued === true,
      inboxDepth: typeof body.inboxDepth === "number" ? body.inboxDepth : 0,
      accepted: body.accepted as PublisherSubmitResult["accepted"],
    };
  }

  /**
   * Fetch the inclusion path and root for `leaf` (0x-prefixed 32-byte hex).
   * Throws {@link RootUnavailableError} when the current root doesn't cover it.
   */
  async getInclusionPath(leaf: string): Promise<PublisherInclusionPath> {
    const body = await this.request(`/v1/reputation/root/${encodeURIComponent(leaf)}`, {
      method: "GET",
    });
    if (
      !isRecord(body) ||
      typeof body.root !== "string" ||
      typeof body.leafIndex !== "number" ||
      !Array.isArray(body.pathElements) ||
      !Array.isArray(body.pathIndices) ||
      body.pathElements.length !== body.pathIndices.length
    ) {
      throw badResponse("getInclusionPath");
    }
    return body as unknown as PublisherInclusionPath;
  }

  /** Fetch the publisher's current root that covers `leaf`. */
  async getRoot(leaf: string): Promise<string> {
    return (await this.getInclusionPath(leaf)).root;
  }

  /** Fetch the full tree snapshot for a verifier contract id. */
  async getSnapshot(verifierId: string): Promise<PublisherSnapshot> {
    const body = await this.request(
      `/v1/reputation/snapshot/${encodeURIComponent(verifierId)}`,
      { method: "GET" },
    );
    if (!isRecord(body) || typeof body.snapshotHash !== "string") {
      throw badResponse("getSnapshot");
    }
    return { snapshot: body.snapshot, snapshotHash: body.snapshotHash };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new PublisherError(`Publisher request to ${path} failed`, {
        reason: "network",
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      if (res.ok) throw badResponse(path, cause);
      body = undefined;
    }
    if (res.ok) return body;
    throw mapHttpError(path, res.status, body);
  }
}

function mapHttpError(path: string, status: number, body: unknown): Error {
  const detail = isRecord(body) && typeof body.error === "string" ? body.error : "";
  const retryAfterSeconds =
    isRecord(body) && typeof body.retryAfterSeconds === "number"
      ? body.retryAfterSeconds
      : undefined;
  const msg = `Publisher ${path} returned HTTP ${status}${detail ? `: ${detail}` : ""}`;
  if (status === 401 || status === 403) {
    return new PublisherError(msg, { reason: "unauthorized", httpStatus: status });
  }
  if (status === 429) {
    return new PublisherError(msg, {
      reason: detail === "inbox full" ? "inbox_full" : "rate_limited",
      httpStatus: status,
      retryAfterSeconds,
    });
  }
  if (status === 400 || status === 413 || status === 422) {
    return new PublisherError(msg, { reason: "invalid_leaf", httpStatus: status });
  }
  if (status === 404 && path.startsWith("/v1/reputation/root/")) {
    return new RootUnavailableError(
      `${msg}. The leaf is not yet included in a published root; retry after the next publish tick.`,
      { cause: new PublisherError(msg, { reason: "not_included", httpStatus: status }) },
    );
  }
  return new PublisherError(msg, { reason: "http", httpStatus: status });
}

function badResponse(op: string, cause?: unknown): PublisherError {
  return new PublisherError(`Malformed publisher response for ${op}`, {
    reason: "bad_response",
    cause,
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
