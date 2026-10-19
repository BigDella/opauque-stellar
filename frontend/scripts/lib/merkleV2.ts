/**
 * TypeScript reimplementation of the scanner's Poseidon Merkle tree
 * (scanner/src/merkle.rs), used by the Phase 3 indexer/publisher and the
 * end-to-end tests. It must produce byte-identical roots/paths to the Rust
 * scanner and the circuit (circuits/v2/stealth_reputation.circom), so a root
 * published on-chain matches what the wallet proves against.
 *
 * Invariants (verified against scanner test vectors):
 *   - Poseidon over the BN254 scalar field (circomlibjs buildPoseidon).
 *   - V2 leaf = Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce).
 *   - Empty leaf = 0; zero-subtree hash at level i = Poseidon(z[i-1], z[i-1]).
 *   - Node hashing: Poseidon(left, right). Path index 0 = node is left child.
 */

import { buildPoseidon } from "circomlibjs";

export const V2_TREE_DEPTH = 20;

let _poseidon: any = null;
export async function getPoseidon() {
  if (!_poseidon) _poseidon = await buildPoseidon();
  return _poseidon;
}

/** Poseidon hash of an array of bigint field elements -> bigint. */
export function hashFields(poseidon: any, inputs: bigint[]): bigint {
  return poseidon.F.toObject(poseidon(inputs));
}

/** bigint field element -> 32-byte big-endian Uint8Array. */
export function toBE32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let n = BigInt(v);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** 32-byte big-endian Uint8Array -> bigint. */
export function fromBE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  return n;
}

export class MerkleV2 {
  poseidon: any;
  depth: number;
  leaves: bigint[];
  /** zero[i] = hash of an empty subtree of height i (zero[0] = 0). */
  zero: bigint[];

  constructor(poseidon: any, depth = V2_TREE_DEPTH) {
    this.poseidon = poseidon;
    this.depth = depth;
    this.leaves = [];
    this.zero = [0n];
    for (let i = 0; i < depth; i++) {
      this.zero.push(hashFields(poseidon, [this.zero[i], this.zero[i]]));
    }
  }

  /** Compute (without inserting) a V2 reputation leaf. */
  v2Leaf(stealthPk: bigint, schemaId: bigint, issuerPkX: bigint, traitDataHash: bigint, nonce: bigint): bigint {
    return hashFields(this.poseidon, [stealthPk, schemaId, issuerPkX, traitDataHash, nonce]);
  }

  insert(leaf: bigint): number {
    if (this.leaves.length >= 1 << this.depth) throw new Error("Merkle tree full");
    this.leaves.push(leaf);
    return this.leaves.length - 1;
  }

  insertV2(stealthPk: bigint, schemaId: bigint, issuerPkX: bigint, traitDataHash: bigint, nonce: bigint): number {
    return this.insert(this.v2Leaf(stealthPk, schemaId, issuerPkX, traitDataHash, nonce));
  }

  /** Root of the subtree of height `level` rooted at leaf-range start. */
  private rootFrom(start: number, level: number): bigint {
    if (start >= this.leaves.length) return this.zero[level]; // entire subtree empty
    if (level === 0) return this.leaves[start];
    const half = 1 << (level - 1);
    const left = this.rootFrom(start, level - 1);
    const right = this.rootFrom(start + half, level - 1);
    return hashFields(this.poseidon, [left, right]);
  }

  root(): bigint {
    return this.rootFrom(0, this.depth);
  }

  /** The node value at (index, level) — mirrors scanner get_node. */
  private node(index: number, level: number): bigint {
    return this.rootFrom(index * (1 << level), level);
  }

  /** Inclusion proof for the leaf at `index` (path bottom-up). */
  proof(index: number): { leaf: bigint; pathElements: bigint[]; pathIndices: number[]; root: bigint } {
    if (index >= this.leaves.length) throw new Error(`leaf index ${index} out of bounds`);
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let cur = index;
    for (let level = 0; level < this.depth; level++) {
      const sib = cur ^ 1;
      pathElements.push(this.node(sib, level));
      pathIndices.push(cur & 1);
      cur >>= 1;
    }
    return { leaf: this.leaves[index], pathElements, pathIndices, root: this.root() };
  }
}
