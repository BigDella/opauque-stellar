/**
 * Circuit artifact resolution. Groth16 proving needs a circuit `.wasm` and a
 * proving-key `.zkey`. Large `.zkey` files are never bundled into the package:
 * an {@link ArtifactResolver} fetches them (and, in integrity-checking
 * implementations, verifies their hash) at proof time.
 *
 * The default {@link urlArtifactResolver} returns URLs suitable for snarkjs in a
 * browser or any fetch-capable runtime. A filesystem-caching resolver for Node
 * lives in the `./node` entry (it needs `fs`).
 *
 * {@link integrityArtifactResolver} wraps any resolver and verifies each
 * artifact's SHA-256 hash against a pinned manifest before returning bytes.
 * It is the recommended resolver for production use.
 */
import { ArtifactError } from "../errors/index";

export type ArtifactId = "reputation-v2" | "pool-v3";
export type ArtifactKind = "wasm" | "zkey";

export interface ArtifactResolver {
  /** Resolve an artifact to a URL string or its raw bytes. */
  resolve(id: ArtifactId, kind: ArtifactKind): Promise<string | Uint8Array>;
}

/** Default relative paths, matching the published circuit release layout. */
export const DEFAULT_ARTIFACT_PATHS: Record<
  ArtifactId,
  Record<ArtifactKind, string>
> = {
  "reputation-v2": {
    wasm: "circuits/v2/stealth_reputation.wasm",
    zkey: "circuits/v2/stealth_reputation_final.zkey",
  },
  "pool-v3": {
    wasm: "circuits/v3/privacy_pool_withdraw.wasm",
    zkey: "circuits/v3/privacy_pool_withdraw_final.zkey",
  },
};

/**
 * Pinned SHA-256 hashes for published circuit artifacts, matching the
 * `artifacts/manifest.json` release entries. Used by {@link integrityArtifactResolver}.
 */
export const ARTIFACT_HASHES: Record<ArtifactId, Record<ArtifactKind, string>> = {
  "reputation-v2": {
    wasm: "238c5a0f34f164d8ac08420a5484c5c7917aaba2ba86bb26ad63206be8364880",
    zkey: "6bbee378c05c2d4f1dfc118fb15e2c7b4bacf78e2518881c576d81da5894442d",
  },
  "pool-v3": {
    wasm: "e3ad169255ecabcceb61f5b0b1399cb5f0276614a24f4a03529041390b779f4c",
    zkey: "60097d74d4df5707f62316d55322e59d5e15f60d789ae2cb82cfb86f92b1a8c3",
  },
};

// ---------------------------------------------------------------------------
// Internal: SHA-256 helper (isomorphic: SubtleCrypto in browser/Node >=18)
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * Build a resolver that maps artifacts to URLs under a base URL. Pass `paths` to
 * override individual artifact locations.
 */
export function urlArtifactResolver(opts: {
  baseUrl: string;
  paths?: Partial<Record<ArtifactId, Partial<Record<ArtifactKind, string>>>>;
}): ArtifactResolver {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async resolve(id, kind) {
      const path = opts.paths?.[id]?.[kind] ?? DEFAULT_ARTIFACT_PATHS[id]?.[kind];
      if (!path) {
        throw new ArtifactError(`No artifact path for ${id}/${kind}`);
      }
      return `${base}/${path.replace(/^\/+/, "")}`;
    },
  };
}

/**
 * Build a resolver that maps artifacts to local filesystem paths under a base
 * directory. The returned path strings are consumed directly by snarkjs in Node.
 */
export function fileArtifactResolver(opts: {
  baseDir: string;
  paths?: Partial<Record<ArtifactId, Partial<Record<ArtifactKind, string>>>>;
}): ArtifactResolver {
  const base = opts.baseDir.replace(/\/+$/, "");
  return {
    async resolve(id, kind) {
      const path = opts.paths?.[id]?.[kind] ?? DEFAULT_ARTIFACT_PATHS[id]?.[kind];
      if (!path) {
        throw new ArtifactError(`No artifact path for ${id}/${kind}`);
      }
      return `${base}/${path.replace(/^\/+/, "")}`;
    },
  };
}

/**
 * Wrap any {@link ArtifactResolver} with SHA-256 integrity verification.
 *
 * When the inner resolver returns a URL, this resolver fetches the bytes and
 * verifies their hash before returning the raw bytes. When the inner resolver
 * already returns bytes, the hash is verified in-place.
 *
 * Hashes are matched against `hashes` (defaults to the manifest-pinned
 * {@link ARTIFACT_HASHES}). A mismatch throws {@link ArtifactError} before the
 * bytes are returned to the caller, so a tampered artifact host cannot feed
 * proving keys that produce unverifiable or leaky proofs.
 *
 * This is the recommended resolver for production use — use it as the default
 * resolver in any integration that fetches artifacts from a remote host.
 *
 * @example
 * ```ts
 * const resolver = integrityArtifactResolver({
 *   inner: urlArtifactResolver({ baseUrl: "https://cdn.example.com/artifacts" }),
 * });
 * ```
 */
export function integrityArtifactResolver(opts: {
  inner: ArtifactResolver;
  hashes?: Record<ArtifactId, Record<ArtifactKind, string>>;
}): ArtifactResolver {
  const hashes = opts.hashes ?? ARTIFACT_HASHES;
  return {
    async resolve(id, kind) {
      const expected = hashes[id]?.[kind];
      if (!expected) {
        throw new ArtifactError(
          `No pinned hash for ${id}/${kind} — cannot verify integrity`,
        );
      }

      const inner = await opts.inner.resolve(id, kind);

      // Fetch bytes when the inner resolver returns a URL string.
      let bytes: Uint8Array;
      if (typeof inner === "string") {
        let response: Response;
        try {
          response = await fetch(inner);
        } catch (err) {
          throw new ArtifactError(
            `Failed to fetch artifact ${id}/${kind} from ${inner}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        if (!response.ok) {
          throw new ArtifactError(
            `Artifact fetch for ${id}/${kind} returned HTTP ${response.status}`,
          );
        }
        bytes = new Uint8Array(await response.arrayBuffer());
      } else {
        bytes = inner;
      }

      const actual = await sha256Hex(bytes);
      if (actual !== expected.toLowerCase()) {
        throw new ArtifactError(
          `Integrity check failed for ${id}/${kind}: ` +
            `expected sha256=${expected} but got sha256=${actual}`,
        );
      }

      return bytes;
    },
  };
}
