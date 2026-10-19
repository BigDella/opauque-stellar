/** Verify merkleV2.ts matches the Rust scanner's Poseidon/tree test vectors. */
import { getPoseidon, hashFields, MerkleV2 } from "./lib/merkleV2.ts";

const POSEIDON_1_2 = 7853200120776062878684798364095072458815029376092732009249414926327459813530n;
const POSEIDON_0_0 = 14744269619966411208579211824598458697587494354926760081771325075741142829156n;

function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok:", msg); }

async function main() {
  const poseidon = await getPoseidon();
  assert(hashFields(poseidon, [1n, 2n]) === POSEIDON_1_2, "Poseidon(1,2) matches scanner vector");
  assert(hashFields(poseidon, [0n, 0n]) === POSEIDON_0_0, "Poseidon(0,0) matches scanner vector");

  const tree = new MerkleV2(poseidon, 20);
  assert(tree.zero[1] === POSEIDON_0_0, "zero-subtree level 1 matches Poseidon(0,0)");

  // V2 leaf = Poseidon(1,2,3,4,5)
  const leaf = tree.v2Leaf(1n, 2n, 3n, 4n, 5n);
  assert(leaf === hashFields(poseidon, [1n, 2n, 3n, 4n, 5n]), "v2 leaf = Poseidon(5 inputs)");

  // Single-leaf-at-index-0 tree: proof + root self-consistency (mirrors circuit path check).
  tree.insert(leaf);
  const p = tree.proof(0);
  let cur = p.leaf;
  for (let i = 0; i < p.pathElements.length; i++) {
    cur = p.pathIndices[i] === 0
      ? hashFields(poseidon, [cur, p.pathElements[i]])
      : hashFields(poseidon, [p.pathElements[i], cur]);
  }
  assert(cur === p.root, "reconstructed root from path == tree root (circuit-ordered)");
  assert(p.pathIndices.every((x) => x === 0), "index-0 leaf has all-left path");
  assert(p.pathElements[0] === 0n && p.pathElements[1] === POSEIDON_0_0, "index-0 siblings are zero-subtree hashes");

  console.log("\nALL MERKLE V2 VECTORS PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
