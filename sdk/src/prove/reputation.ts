/**
 * Reputation prover: build the V2 witness (Poseidon) and generate a Groth16
 * proof via snarkjs, returning a bundle ready for on-chain verification.
 *
 * The witness here is the single-leaf (tree-of-zeros) construction the protocol
 * uses for a holder's own attestation; it produces the same root a real indexer
 * publishes for that leaf. Public-signal order is canonical:
 *   [0] merkle_root  [1] attestation_id  [2] external_nullifier  [3] nullifier_hash
 */
import { bigIntToBytes32, bytesToBigInt } from "../crypto/bytes";
import { getPoseidon } from "../crypto/notes";
import { ArtifactError } from "../errors/index";
import type { ArtifactResolver } from "../artifacts/index";
import type { VerifyReputationInputs } from "../contracts/verifier";
import { serializeGroth16Proof } from "./serialize";
import { runProofJobs, type ProofPoolOptions } from "./worker-pool";

const TREE_DEPTH = 20;

type PoseidonField = {
  e(x: bigint): unknown;
  toObject(x: unknown): bigint;
};

export interface ReputationProveInput {
  /** Attestation id (== schema id) of the trait being proven. */
  attestationId: number;
  /** The holder's stealth private key bytes. */
  stealthPrivKey: Uint8Array;
  /** Application-chosen external nullifier (must fit in u64 for the contract). */
  externalNullifier: bigint;
  /**
   * Real inclusion path from the reputation publisher
   * (`opaque.reputation.publisher().getInclusionPath(leaf)`). When omitted the
   * single-leaf tree-of-zeros path is used. Values are decimal or 0x-hex.
   */
  inclusion?: {
    root: string;
    pathElements: string[];
    pathIndices: number[];
  };
}

export interface ReputationWitnessV2 {
  stealth_pk: string;
  schema_id: string;
  issuer_pk_x: string;
  trait_data_hash: string;
  nonce: string;
  merkle_path: string[];
  merkle_path_indices: number[];
  merkle_root: string;
  attestation_id: string;
  external_nullifier: string;
  nullifier_hash: string;
}

/**
 * Compute the holder's V2 reputation Merkle leaf (0x-prefixed 32-byte hex) —
 * the value submitted to, and looked up on, the reputation publisher.
 */
export async function computeReputationLeaf(
  input: Pick<ReputationProveInput, "attestationId" | "stealthPrivKey">,
): Promise<string> {
  const w = await buildReputationWitnessV2({ ...input, externalNullifier: 0n });
  const poseidon = (await getPoseidon()) as unknown as ((i: bigint[]) => unknown) & {
    F: PoseidonField;
  };
  const leaf = poseidon.F.toObject(
    poseidon([
      BigInt(w.stealth_pk),
      BigInt(w.schema_id),
      BigInt(w.issuer_pk_x),
      BigInt(w.trait_data_hash),
      BigInt(w.nonce),
    ]),
  );
  return "0x" + leaf.toString(16).padStart(64, "0");
}

/** Build the canonical V2 reputation witness for a holder's own attestation. */
export async function buildReputationWitnessV2(
  input: ReputationProveInput,
): Promise<ReputationWitnessV2> {
  const poseidon = (await getPoseidon()) as unknown as ((i: bigint[]) => unknown) & {
    F: PoseidonField;
  };
  const F = poseidon.F;

  const stealthPk = F.toObject(F.e(bytesToBigInt(input.stealthPrivKey)));
  const schemaId = BigInt(input.attestationId);
  const extNullifier = input.externalNullifier;

  const issuerPkX = F.toObject(poseidon([stealthPk, 1n]));
  const traitDataHash = F.toObject(poseidon([schemaId, 2n]));
  const nonce = F.toObject(poseidon([stealthPk, 3n]));

  const leaf = F.toObject(
    poseidon([stealthPk, schemaId, issuerPkX, traitDataHash, nonce]),
  );

  let merklePath: string[];
  let merklePathIndices: number[];
  let merkleRoot: bigint;
  if (input.inclusion) {
    const { root, pathElements, pathIndices } = input.inclusion;
    if (pathElements.length !== TREE_DEPTH || pathIndices.length !== TREE_DEPTH) {
      throw new ArtifactError(
        `Inclusion path must have depth ${TREE_DEPTH} (got ${pathElements.length}/${pathIndices.length})`,
      );
    }
    merklePath = pathElements.map((x) => BigInt(x).toString());
    merklePathIndices = pathIndices.map((x) => (x ? 1 : 0));
    let current = leaf;
    for (let i = 0; i < TREE_DEPTH; i++) {
      const sibling = BigInt(merklePath[i]);
      current = F.toObject(
        merklePathIndices[i] ? poseidon([sibling, current]) : poseidon([current, sibling]),
      );
    }
    merkleRoot = BigInt(root);
    if (current !== merkleRoot) {
      throw new ArtifactError(
        "Inclusion path does not hash to the published root for this holder's leaf",
      );
    }
  } else {
    // Empty-subtree roots: z[0] = 0, z[i] = Poseidon(z[i-1], z[i-1]).
    const zeroHashes: bigint[] = [0n];
    for (let i = 0; i < TREE_DEPTH; i++) {
      zeroHashes.push(F.toObject(poseidon([zeroHashes[i], zeroHashes[i]])));
    }
    merklePath = [];
    merklePathIndices = [];
    let current = leaf;
    for (let i = 0; i < TREE_DEPTH; i++) {
      merklePath.push(zeroHashes[i].toString());
      merklePathIndices.push(0);
      current = F.toObject(poseidon([current, zeroHashes[i]]));
    }
    merkleRoot = current;
  }
  const nullifierHash = F.toObject(poseidon([stealthPk, extNullifier]));

  return {
    stealth_pk: stealthPk.toString(),
    schema_id: schemaId.toString(),
    issuer_pk_x: issuerPkX.toString(),
    trait_data_hash: traitDataHash.toString(),
    nonce: nonce.toString(),
    merkle_path: merklePath,
    merkle_path_indices: merklePathIndices,
    merkle_root: merkleRoot.toString(),
    attestation_id: schemaId.toString(),
    external_nullifier: extNullifier.toString(),
    nullifier_hash: nullifierHash.toString(),
  };
}

interface SnarkjsLike {
  groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: import("./serialize").Groth16ProofLike; publicSignals: string[] }>;
  };
}

async function loadSnarkjs(): Promise<SnarkjsLike> {
  try {
    return (await import("snarkjs")) as unknown as SnarkjsLike;
  } catch (cause) {
    throw new ArtifactError(
      "snarkjs is required for proof generation; install it as a peer dependency.",
      { cause },
    );
  }
}

export interface ReputationProof extends VerifyReputationInputs {
  publicSignals: string[];
}

/**
 * Generate a V2 reputation proof and return a bundle ready for
 * `reputation.verifyOnChain` / the reputation-verifier contract.
 */
export async function proveReputationV2(opts: {
  input: ReputationProveInput;
  artifacts: ArtifactResolver;
  snarkjs?: SnarkjsLike;
}): Promise<ReputationProof> {
  const witness = await buildReputationWitnessV2(opts.input);
  const snarkjs = opts.snarkjs ?? (await loadSnarkjs());
  const [wasm, zkey] = await Promise.all([
    opts.artifacts.resolve("reputation-v2", "wasm"),
    opts.artifacts.resolve("reputation-v2", "zkey"),
  ]);

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness as unknown as Record<string, unknown>,
    wasm,
    zkey,
  );
  const { a, b, c } = serializeGroth16Proof(proof);

  return {
    proofA: a,
    proofB: b,
    proofC: c,
    merkleRoot: bigIntToBytes32(BigInt(publicSignals[0])),
    attestationId: bigIntToBytes32(BigInt(publicSignals[1])),
    externalNullifier: opts.input.externalNullifier,
    nullifierHash: bigIntToBytes32(BigInt(publicSignals[3])),
    publicSignals,
  };
}

/**
 * Generate V2 reputation proofs for several independent inputs. Parallelizes
 * the CPU-heavy `fullProve` calls across a worker pool when one is available
 * (same fallback rules as {@link import("./pool").provePoolWithdrawBatch}); the
 * serial path is exactly {@link proveReputationV2} called in a loop, so results
 * are identical either way for the same inputs.
 */
export async function proveReputationV2Batch(opts: {
  inputs: ReputationProveInput[];
  artifacts: ArtifactResolver;
  snarkjs?: SnarkjsLike;
  /** `false` forces serial proving; omit to auto-detect a worker pool. */
  pool?: ProofPoolOptions | false;
}): Promise<ReputationProof[]> {
  const witnesses = await Promise.all(opts.inputs.map(buildReputationWitnessV2));
  const [wasm, zkey] = await Promise.all([
    opts.artifacts.resolve("reputation-v2", "wasm"),
    opts.artifacts.resolve("reputation-v2", "zkey"),
  ]);

  const results = await runProofJobs(
    witnesses.map((w) => ({ input: w as unknown as Record<string, unknown>, wasm, zkey })),
    { snarkjs: opts.snarkjs, pool: opts.pool },
  );

  return results.map((r, i) => {
    const { a, b, c } = serializeGroth16Proof(r.proof);
    return {
      proofA: a,
      proofB: b,
      proofC: c,
      merkleRoot: bigIntToBytes32(BigInt(r.publicSignals[0])),
      attestationId: bigIntToBytes32(BigInt(r.publicSignals[1])),
      externalNullifier: opts.inputs[i].externalNullifier,
      nullifierHash: bigIntToBytes32(BigInt(r.publicSignals[3])),
      publicSignals: r.publicSignals,
    };
  });
}
