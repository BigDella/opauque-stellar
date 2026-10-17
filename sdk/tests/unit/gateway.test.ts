/**
 * Unit tests for RelayerGateway: timeout, abort, failover, retry, and typed
 * error surfacing.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GatewayError } from "../../src/errors";
import {
  RelayerGateway,
  DEFAULT_GATEWAY_TIMEOUT_MS,
} from "../../src/relayer-protocol/gateway";
import type { ContractInvoker } from "../../src/rpc/client";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function stubInvoker(): ContractInvoker {
  return {
    invoke: vi.fn() as any,
    readNative: vi.fn() as any,
    simulateRead: vi.fn() as any,
    getEvents: vi.fn() as any,
    getLatestLedger: vi.fn(async () => 1000),
  } as unknown as ContractInvoker;
}

function gw(
  urls = ["http://gw-a.example", "http://gw-b.example"],
  overrides?: { timeoutMs?: number; retries?: number },
): RelayerGateway {
  return new RelayerGateway({
    gatewayUrls: urls,
    registryId: "CAAAAAAA",
    invoker: stubInvoker(),
    ...overrides,
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Mock fetch that resolves after `ms` BUT also respects an AbortSignal:
 * if the signal fires before the delay, the returned promise rejects with an
 * AbortError — exactly the same contract as real `fetch`.
 */
function signalAwareFetch(ms: number, responseData?: unknown) {
  return vi.fn(
    (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(new DOMException("This operation was aborted", "AbortError"));
          return;
        }
        const timer = setTimeout(
          () => resolve(jsonResponse(responseData ?? {})),
          ms,
        );
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("This operation was aborted", "AbortError"));
          },
          { once: true },
        );
      }),
  );
}

const ADVERT = {
  t: "advert" as const,
  v: 1 as const,
  jobId: "0x" + "00".repeat(32),
  chain: 3000,
  fee: "100",
  deadline: 9999,
  payloadHash: "0x" + "aa".repeat(32),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RelayerGateway", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // --- constructor --------------------------------------------------------

  describe("constructor", () => {
    it("rejects an empty gateway URL list", () => {
      expect(() => gw([])).toThrow("at least one gateway URL");
    });

    it("accepts custom timeout and retries", () => {
      const g = gw(["http://a"], { timeoutMs: 500, retries: 3 });
      expect(g).toBeDefined();
    });
  });

  // --- timeout ------------------------------------------------------------

  describe("timeout", () => {
    it("throws GatewayError with code GATEWAY on timeout", async () => {
      globalThis.fetch = signalAwareFetch(5000);
      const g = gw(["http://slow"], { timeoutMs: 50, retries: 1 });

      await expect(g.publishAdvert(ADVERT)).rejects.toThrow(GatewayError);
    });

    it("surfaces timeout as GatewayError with cause", async () => {
      globalThis.fetch = signalAwareFetch(5000);
      const g = gw(["http://slow"], { timeoutMs: 50, retries: 1 });

      try {
        await g.publishAdvert(ADVERT);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).code).toBe("GATEWAY");
        expect((err as GatewayError).message).toMatch(/abort|timed/i);
        expect((err as GatewayError).cause).toBeDefined();
      }
    });

    it("uses default timeout when none specified", async () => {
      // Mock blocks for 30s but timeout fires at DEFAULT_GATEWAY_TIMEOUT_MS (10s).
      globalThis.fetch = signalAwareFetch(30_000);
      const g = gw(["http://slow"], { retries: 1 });
      const start = Date.now();

      try {
        await g.publishAdvert(ADVERT);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        // Timeout fires at ~10s; allow generous margin for CI.
        expect(Date.now() - start).toBeLessThan(DEFAULT_GATEWAY_TIMEOUT_MS + 2000);
      }
    }, 20_000);

    it("per-request timeoutMs overrides the constructor default", async () => {
      globalThis.fetch = signalAwareFetch(5000);
      const g = gw(["http://slow"], { timeoutMs: 10_000, retries: 1 });

      try {
        await g.publishAdvert(ADVERT, { timeoutMs: 50 });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
      }
    });
  });

  // --- abort ---------------------------------------------------------------

  describe("abort", () => {
    it("throws GatewayError when caller aborts before completion", async () => {
      const controller = new AbortController();
      globalThis.fetch = signalAwareFetch(5000);
      const g = gw(["http://slow"], { retries: 1 });

      setTimeout(() => controller.abort(), 30);

      try {
        await g.publishAdvert(ADVERT, { signal: controller.signal });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).message).toMatch(/abort/i);
      }
    });

    it("aborts in-flight fetch and does not retry on caller abort", async () => {
      const controller = new AbortController();
      let fetchCount = 0;
      globalThis.fetch = vi.fn((_url: any, init?: any) => {
        fetchCount += 1;
        return new Promise((resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          const timer = setTimeout(() => resolve(jsonResponse({})), 5000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }) as any;
      const g = gw(["http://a", "http://b"], { retries: 2 });

      setTimeout(() => controller.abort(), 30);

      try {
        await g.publishAdvert(ADVERT, { signal: controller.signal });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect(fetchCount).toBe(1);
      }
    });

    it("rejects immediately when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort(new Error("already done"));
      globalThis.fetch = vi.fn() as any;
      const g = gw(["http://a"], { retries: 1 });

      try {
        await g.publishAdvert(ADVERT, { signal: controller.signal });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).message).toMatch(/abort/i);
      }
    });

    it("does not invoke fetch when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      globalThis.fetch = vi.fn() as any;
      const g = gw(["http://a"], { retries: 1 });

      try {
        await g.publishAdvert(ADVERT, { signal: controller.signal });
      } catch {
        // Expected.
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  // --- failover & retry ---------------------------------------------------

  describe("failover", () => {
    it("tries the next gateway on a 503 and succeeds", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn((_url: string | URL | Request) => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
        }
        return Promise.resolve(jsonResponse({ bids: [] }));
      }) as any;

      const g = gw(["http://gw-a", "http://gw-b"], { retries: 2 });
      const bids = await g.fetchBids("0x" + "00".repeat(32));

      expect(bids).toEqual([]);
      expect(callCount).toBe(2);
    });

    it("retries on network/fetch error and succeeds on second gateway", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(new TypeError("fetch failed"));
        }
        return Promise.resolve(jsonResponse({ bids: [] }));
      }) as any;

      const g = gw(["http://gw-a", "http://gw-b"], { retries: 2 });
      const bids = await g.fetchBids("0x" + "00".repeat(32));

      expect(bids).toEqual([]);
      expect(callCount).toBe(2);
    });

    it("does NOT retry on 400 (non-retryable client error)", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount += 1;
        return Promise.resolve(new Response("Bad Request", { status: 400 }));
      }) as any;

      const g = gw(["http://gw-a", "http://gw-b"], { retries: 2 });

      try {
        await g.fetchBids("0x" + "00".repeat(32));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).httpStatus).toBe(400);
        expect(callCount).toBe(1);
      }
    });

    it("does NOT retry on 404", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount += 1;
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }) as any;

      const g = gw(["http://gw-a"], { retries: 2 });

      try {
        await g.publishAdvert(ADVERT);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).httpStatus).toBe(404);
        expect(callCount).toBe(1);
      }
    });

    it("retries on 502 across all gateways before failing", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount += 1;
        return Promise.resolve(new Response("Bad Gateway", { status: 502 }));
      }) as any;

      const g = gw(["http://gw-a", "http://gw-b"], { retries: 2 });

      try {
        await g.fetchBids("0x" + "00".repeat(32));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).httpStatus).toBe(502);
        expect(callCount).toBe(2);
      }
    });

    it("retries on 429 (rate limit)", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount += 1;
        if (callCount <= 2) {
          return Promise.resolve(new Response("Too Many Requests", { status: 429 }));
        }
        return Promise.resolve(jsonResponse({ bids: [] }));
      }) as any;

      const g = gw(["http://gw-a", "http://gw-b", "http://gw-c"], { retries: 3 });
      const bids = await g.fetchBids("0x" + "00".repeat(32));
      expect(bids).toEqual([]);
      expect(callCount).toBe(3);
    });
  });

  // --- typed errors --------------------------------------------------------

  describe("typed errors", () => {
    it("throws GatewayError (not plain Error) for HTTP failures", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500 })),
      ) as any;

      const g = gw(["http://gw-a"], { retries: 1 });

      try {
        await g.publishAdvert(ADVERT);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).code).toBe("GATEWAY");
        expect((err as GatewayError).httpStatus).toBe(500);
        expect((err as GatewayError).gatewayUrl).toBe("http://gw-a");
      }
    });

    it("includes gatewayUrl in error for debugging which node failed", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount += 1;
        return Promise.resolve(new Response("error", { status: 502 }));
      }) as any;

      const g = gw(["http://gw-a", "http://gw-b"], { retries: 2 });

      try {
        await g.fetchBids("0x" + "00".repeat(32));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).gatewayUrl).toBe("http://gw-b");
      }
    });

    it("wraps fetch TypeError (network error) as GatewayError", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.reject(new TypeError("Failed to fetch")),
      ) as any;

      const g = gw(["http://gw-a"], { retries: 1 });

      try {
        await g.publishAdvert(ADVERT);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as GatewayError).cause).toBeInstanceOf(TypeError);
      }
    });
  });

  // --- publishAdvert success -----------------------------------------------

  describe("publishAdvert", () => {
    it("succeeds on first gateway", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response("{}", { status: 202 })),
      ) as any;

      const g = gw(["http://gw-a"]);
      await expect(g.publishAdvert(ADVERT)).resolves.toBeUndefined();
    });
  });

  // --- fetchBids -----------------------------------------------------------

  describe("fetchBids", () => {
    it("returns empty array when no bids", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(jsonResponse({ bids: [] })),
      ) as any;

      const g = gw(["http://gw-a"]);
      const bids = await g.fetchBids("0x" + "00".repeat(32));
      expect(bids).toEqual([]);
    });

    it("passes options through to gatewayFetch (signal + gateway override)", async () => {
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn((_url: string | URL | Request, init?: any) => {
        receivedSignal = init?.signal;
        return Promise.resolve(jsonResponse({ bids: [] }));
      }) as any;

      const g = gw(["http://gw-a"]);
      const bids = await g.fetchBids("0x" + "00".repeat(32), {
        signal: controller.signal,
        timeoutMs: 5000,
        gateway: "http://gw-c",
      });
      expect(bids).toEqual([]);

      // URL should use the gateway override.
      const callArgs = (globalThis.fetch as any).mock.calls[0];
      const url = String(callArgs[0]);
      expect(url).toContain("gw-c");

      // The signal passed to fetch should abort when the caller's signal aborts
      // (it's a composite AbortSignal.any() — not the same object, but linked).
      let signalAborted = false;
      receivedSignal!.addEventListener("abort", () => { signalAborted = true; }, { once: true });
      controller.abort();
      expect(signalAborted).toBe(true);
    });
  });

  // --- deliverPayload ------------------------------------------------------

  describe("deliverPayload", () => {
    const DRAFT = {
      jobId: new Uint8Array(32),
      jobIdHex: "00".repeat(32),
      payload: {
        poolId: "CPOOL",
        proofA: new Uint8Array(64),
        proofB: new Uint8Array(128),
        proofC: new Uint8Array(64),
        withdrawnValue: 1000n,
        stateRoot: new Uint8Array(32),
        aspRoot: new Uint8Array(32),
        nullifierHash: new Uint8Array(32),
        newCommitment: new Uint8Array(32),
        recipient: "GADDR",
        poolFee: 0n,
        poolRelayer: "CREG",
      } as any,
      payloadHash: new Uint8Array(32),
      payloadHashHex: "aa".repeat(32),
      advert: {} as any,
      deadlineLedger: 100,
      fee: 100n,
    };
    const BID = {
      t: "bid" as const,
      v: 1 as const,
      jobId: "00".repeat(32),
      chain: 3000,
      operator: "GTEST",
      x25519Pk: "bb".repeat(32),
      sig: "sig",
    };

    it("returns result from gateway", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(jsonResponse({
          result: { acceptedTx: "acc-tx", submittedTx: "sub-tx" },
        })),
      ) as any;

      const g = gw(["http://gw-a"]);
      const result = await g.deliverPayload({ draft: DRAFT, bid: BID });
      expect(result).toEqual({ acceptedTx: "acc-tx", submittedTx: "sub-tx" });
    });

    it("sends a stable X-Idempotency-Key header on every delivery attempt", async () => {
      const headers: string[] = [];
      globalThis.fetch = vi.fn((_url: any, init?: any) => {
        headers.push(
          (init?.headers as Record<string, string>)?.["x-idempotency-key"] ?? "",
        );
        return Promise.resolve(jsonResponse({ result: null }));
      }) as any;

      const g = gw(["http://gw-a"]);
      await g.deliverPayload({ draft: DRAFT, bid: BID });

      expect(headers).toHaveLength(1);
      expect(headers[0]).toBeTruthy();
      expect(headers[0]).toContain(DRAFT.jobIdHex);
      expect(headers[0]).toContain(BID.x25519Pk);
    });

    it("sends the same idempotency key on retries (slow gateway triggers retry)", async () => {
      const capturedKeys: string[] = [];
      let callCount = 0;

      globalThis.fetch = vi.fn((_url: any, init?: any) => {
        callCount += 1;
        capturedKeys.push(
          (init?.headers as Record<string, string>)?.["x-idempotency-key"] ?? "",
        );
        if (callCount === 1) {
          // First attempt: simulate the 10s gateway timeout (return a 503 so
          // the client retries without needing a real timer delay).
          return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
        }
        return Promise.resolve(jsonResponse({ result: { acceptedTx: "tx-abc" } }));
      }) as any;

      const g = gw(["http://gw-a", "http://gw-b"], { retries: 1 });
      const result = await g.deliverPayload({ draft: DRAFT, bid: BID });

      expect(result).toEqual({ acceptedTx: "tx-abc" });
      // Two attempts were made (initial + 1 retry).
      expect(callCount).toBe(2);
      // Both requests carried the exact same idempotency key.
      expect(capturedKeys[0]).toBeTruthy();
      expect(capturedKeys[0]).toBe(capturedKeys[1]);
    });

    it("retries: 0 makes exactly one delivery attempt", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount += 1;
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }) as any;

      const g = gw(["http://gw-a"], { retries: 0 });

      try {
        await g.deliverPayload({ draft: DRAFT, bid: BID });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect(callCount).toBe(1);
      }
    });
  });

  // --- timeout + failover interaction --------------------------------------

  describe("timeout + failover interaction", () => {
    it("times out on first gateway, retries on second which also times out", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn((_url: any, init?: any) => {
        callCount += 1;
        return new Promise((resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          const timer = setTimeout(() => resolve(jsonResponse({})), 30_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }) as any;

      const g = gw(["http://gw-a", "http://gw-b"], { timeoutMs: 50, retries: 2 });

      try {
        await g.fetchBids("0x" + "00".repeat(32));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayError);
        expect(callCount).toBe(2);
      }
    });

    it("times out on first gateway, succeeds on second", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn((_url: any, init?: any) => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise((resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            const timer = setTimeout(() => resolve(jsonResponse({})), 30_000);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
        return Promise.resolve(jsonResponse({ bids: [] }));
      }) as any;

      const g = gw(["http://gw-a", "http://gw-b"], { timeoutMs: 50, retries: 2 });
      const bids = await g.fetchBids("0x" + "00".repeat(32));
      expect(bids).toEqual([]);
      expect(callCount).toBe(2);
    });
  });
});
