import { describe, it, expect } from "vitest";
import {
  PublisherClient,
  PublisherError,
  RootUnavailableError,
  ConfigError,
} from "../../src/index";

const LEAF = "0x" + "11".repeat(32);

function mockFetch(status: number, body: unknown, seen: Request[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(String(url), init));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("PublisherClient", () => {
  it("requires a base URL", () => {
    expect(() => new PublisherClient({ baseUrl: "" })).toThrow(ConfigError);
  });

  it("submits a leaf with the bearer token", async () => {
    const seen: Request[] = [];
    const client = new PublisherClient({
      baseUrl: "https://pub.example/",
      submitToken: "t0k",
      fetch: mockFetch(202, { ok: true, queued: true, inboxDepth: 3, accepted: { id: LEAF, leaf: LEAF } }, seen),
    });
    const res = await client.submitLeaf({ leaf: LEAF });
    expect(res).toEqual({ queued: true, inboxDepth: 3, accepted: { id: LEAF, leaf: LEAF } });
    expect(seen[0].url).toBe("https://pub.example/v1/reputation/leaves");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.get("authorization")).toBe("Bearer t0k");
  });

  it("fetches an inclusion path and root", async () => {
    const path = {
      verifierId: "CVER",
      leaf: LEAF,
      leafIndex: 0,
      leafCount: 1,
      root: "0x" + "22".repeat(32),
      datasetHash: "0x" + "33".repeat(32),
      pathElements: Array(20).fill("0"),
      pathIndices: Array(20).fill(0),
    };
    const client = new PublisherClient({ baseUrl: "https://pub.example", fetch: mockFetch(200, path) });
    expect(await client.getInclusionPath(LEAF)).toEqual(path);
    expect(await client.getRoot(LEAF)).toBe(path.root);
  });

  it("maps a missing leaf to RootUnavailableError", async () => {
    const client = new PublisherClient({
      baseUrl: "https://pub.example",
      fetch: mockFetch(404, { ok: false, error: "leaf not included in the current reputation root" }),
    });
    await expect(client.getInclusionPath(LEAF)).rejects.toBeInstanceOf(RootUnavailableError);
  });

  it.each([
    [401, { ok: false, error: "unauthorized" }, "unauthorized"],
    [429, { ok: false, error: "rate limit exceeded", retryAfterSeconds: 5 }, "rate_limited"],
    [429, { ok: false, error: "inbox full", retryAfterSeconds: 30 }, "inbox_full"],
    [400, { ok: false, error: "leaf must be hex" }, "invalid_leaf"],
    [500, { ok: false, error: "boom" }, "http"],
  ])("maps HTTP %i to a typed PublisherError", async (status, body, reason) => {
    const client = new PublisherClient({ baseUrl: "https://pub.example", fetch: mockFetch(status, body) });
    const err = await client.submitLeaf({ leaf: LEAF }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublisherError);
    expect((err as PublisherError).reason).toBe(reason);
    expect((err as PublisherError).httpStatus).toBe(status);
    expect((err as PublisherError).code).toBe("PUBLISHER");
  });

  it("maps network failures and malformed bodies", async () => {
    const down = new PublisherClient({
      baseUrl: "https://pub.example",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.getRoot(LEAF)).rejects.toMatchObject({ reason: "network" });

    const bad = new PublisherClient({ baseUrl: "https://pub.example", fetch: mockFetch(200, { nope: 1 }) });
    await expect(bad.getInclusionPath(LEAF)).rejects.toMatchObject({ reason: "bad_response" });
  });
});
