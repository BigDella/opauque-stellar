/**
 * Unit tests for integrityArtifactResolver (#1182).
 *
 * Verifies that:
 * - A correctly-hashed artifact passes the check and its bytes are returned.
 * - A tampered artifact throws ArtifactError with a typed code.
 * - An artifact with no pinned hash throws ArtifactError.
 * - URL-returning inner resolvers are fetched and verified.
 * - Byte-returning inner resolvers are verified without an extra fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  integrityArtifactResolver,
  urlArtifactResolver,
  ARTIFACT_HASHES,
  type ArtifactId,
  type ArtifactKind,
  type ArtifactResolver,
} from "../../src/artifacts/index";
import { ArtifactError } from "../../src/errors/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a resolver that immediately returns the provided bytes. */
function bytesResolver(bytes: Uint8Array): ArtifactResolver {
  return { resolve: async () => bytes };
}

/** Build a resolver that immediately returns the provided URL string. */
function urlResolver(url: string): ArtifactResolver {
  return { resolve: async () => url };
}

/** Compute SHA-256 of bytes using SubtleCrypto (same path as production code). */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integrityArtifactResolver", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const ID: ArtifactId = "pool-v3";
  const KIND: ArtifactKind = "wasm";
  const EXPECTED_HASH = ARTIFACT_HASHES[ID][KIND];

  // Build a 16-byte payload whose SHA-256 matches the pinned hash by computing
  // an actual hash — we don't control the production manifest bytes, so we use
  // a custom hashes map in tests that matches real payloads we generate.
  const GOOD_BYTES = new Uint8Array([1, 2, 3, 4]);

  it("passes bytes that match the pinned hash", async () => {
    const hash = await sha256(GOOD_BYTES);
    const resolver = integrityArtifactResolver({
      inner: bytesResolver(GOOD_BYTES),
      hashes: { [ID]: { [KIND]: hash } } as any,
    });

    const result = await resolver.resolve(ID, KIND);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(GOOD_BYTES);
  });

  it("throws ArtifactError with code ARTIFACT for tampered bytes", async () => {
    const hash = await sha256(GOOD_BYTES);
    const tampered = new Uint8Array([9, 9, 9, 9]);
    const resolver = integrityArtifactResolver({
      inner: bytesResolver(tampered),
      hashes: { [ID]: { [KIND]: hash } } as any,
    });

    await expect(resolver.resolve(ID, KIND)).rejects.toThrow(ArtifactError);

    try {
      await resolver.resolve(ID, KIND);
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactError);
      expect((err as ArtifactError).code).toBe("ARTIFACT");
      expect((err as ArtifactError).message).toMatch(/integrity check failed/i);
      expect((err as ArtifactError).message).toContain(hash);
    }
  });

  it("throws ArtifactError when no pinned hash exists for the artifact", async () => {
    const resolver = integrityArtifactResolver({
      inner: bytesResolver(GOOD_BYTES),
      hashes: {} as any,
    });

    await expect(resolver.resolve(ID, KIND)).rejects.toThrow(ArtifactError);

    try {
      await resolver.resolve(ID, KIND);
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactError);
      expect((err as ArtifactError).message).toMatch(/no pinned hash/i);
    }
  });

  it("fetches bytes from URL when inner resolver returns a string", async () => {
    const goodBytes = new Uint8Array([5, 6, 7, 8]);
    const hash = await sha256(goodBytes);

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(goodBytes.buffer, {
          status: 200,
          headers: { "content-type": "application/wasm" },
        }),
      ),
    ) as any;

    const resolver = integrityArtifactResolver({
      inner: urlResolver("https://cdn.example.com/pool-v3.wasm"),
      hashes: { [ID]: { [KIND]: hash } } as any,
    });

    const result = await resolver.resolve(ID, KIND);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://cdn.example.com/pool-v3.wasm",
    );
  });

  it("throws ArtifactError on non-2xx fetch response", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as any;

    const resolver = integrityArtifactResolver({
      inner: urlResolver("https://cdn.example.com/missing.wasm"),
      hashes: { [ID]: { [KIND]: EXPECTED_HASH } } as any,
    });

    await expect(resolver.resolve(ID, KIND)).rejects.toThrow(ArtifactError);

    try {
      await resolver.resolve(ID, KIND);
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactError);
      expect((err as ArtifactError).message).toMatch(/HTTP 404/);
    }
  });

  it("throws ArtifactError when fetch itself throws (network error)", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    ) as any;

    const resolver = integrityArtifactResolver({
      inner: urlResolver("https://unreachable.example.com/artifact.wasm"),
      hashes: { [ID]: { [KIND]: EXPECTED_HASH } } as any,
    });

    await expect(resolver.resolve(ID, KIND)).rejects.toThrow(ArtifactError);

    try {
      await resolver.resolve(ID, KIND);
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactError);
      expect((err as ArtifactError).message).toMatch(/failed to fetch/i);
      expect((err as ArtifactError).cause).toBeInstanceOf(TypeError);
    }
  });

  it("uses ARTIFACT_HASHES by default when no hashes option is provided", async () => {
    // Build bytes that actually match the pinned manifest hash for pool-v3/wasm.
    // Since we cannot reproduce the real artifact bytes here, we verify that
    // bytes with a WRONG hash are rejected using the default hashes table.
    const wrongBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const resolver = integrityArtifactResolver({
      inner: bytesResolver(wrongBytes),
    });

    await expect(resolver.resolve(ID, KIND)).rejects.toThrow(ArtifactError);
  });

  it("wraps urlArtifactResolver and verifies a correct artifact end-to-end", async () => {
    const goodBytes = new Uint8Array([10, 20, 30, 40]);
    const hash = await sha256(goodBytes);

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(goodBytes.buffer, {
          status: 200,
          headers: { "content-type": "application/wasm" },
        }),
      ),
    ) as any;

    const resolver = integrityArtifactResolver({
      inner: urlArtifactResolver({ baseUrl: "https://cdn.example.com" }),
      hashes: { [ID]: { [KIND]: hash } } as any,
    });

    const result = await resolver.resolve(ID, KIND);
    expect(result).toBeInstanceOf(Uint8Array);
  });
});
