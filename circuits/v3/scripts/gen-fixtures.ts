/**
 * Generate deterministic fixtures for the V3 privacy-pool withdraw circuit:
 *   circuits/fixtures/v3/{valid-input,invalid-input,expected-public}.json
 *
 * Builds a fully consistent witness — a deposit commitment inserted into a depth-20
 * Poseidon state tree and its label inserted into a depth-20 ASP tree — so the valid
 * fixture proves + verifies, and an invalid fixture (tampered nullifierHash) fails the
 * circuit's binding constraint. Uses circomlibjs Poseidon, byte-matching the on-chain
 * roots the ASP / state-root publishers compute.
 *
 * Usage: tsx circuits/v3/scripts/gen-fixtures.ts
 */
import { buildPoseidon } from "circomlibjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../../fixtures/v3");
const DEPTH = 20;

let poseidon;
const H = (inputs) => poseidon.F.toObject(poseidon(inputs.map((x) => poseidon.F.e(x))));

/** Depth-`DEPTH` Poseidon Merkle tree with a single leaf; returns root + inclusion path. */
function singleLeafTree(leaf) {
  // zero[i] = hash of an empty subtree of height i.
  const zero = [0n];
  for (let i = 0; i < DEPTH; i++) zero.push(H([zero[i], zero[i]]));
  // Leaf at index 0: every sibling up the path is the zero-subtree of that level,
  // and the leaf is always the left child (pathIndex 0).
  const siblings = [];
  const indices = [];
  let cur = leaf;
  for (let i = 0; i < DEPTH; i++) {
    siblings.push(zero[i]);
    indices.push(0);
    cur = H([cur, zero[i]]);
  }
  return { root: cur, siblings, indices };
}

async function main() {
  poseidon = await buildPoseidon();
  mkdirSync(FIXTURE_DIR, { recursive: true });

  // Deposit secrets + amounts (XLM stroops; well within 64 bits).
  const value = 1_000_000_000n; // 100 XLM
  const withdrawnValue = 400_000_000n; // 40 XLM
  const remainder = value - withdrawnValue;
  const scope = 42n;
  const depositIndex = 0n;
  const label = H([scope, depositIndex]);

  const nullifier = 11111111111111111111n;
  const secret = 22222222222222222222n;
  const newNullifier = 33333333333333333333n;
  const newSecret = 44444444444444444444n;

  const precommitment = H([nullifier, secret]);
  const commitment = H([value, label, precommitment]);
  const nullifierHash = H([nullifier]);
  const newPrecommitment = H([newNullifier, newSecret]);
  const newCommitment = H([remainder, label, newPrecommitment]);

  const state = singleLeafTree(commitment);
  const asp = singleLeafTree(label);

  // context: any bound field element. In production it is keccak256(recipient ∥
  // withdrawnValue ∥ fee ∥ relayer ∥ scope) mod p; here a fixed representative value.
  const context =
    19283746556473829100000000000000000000000000000000000000000000000000000000n %
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  const validInput = {
    withdrawnValue: withdrawnValue.toString(),
    stateRoot: state.root.toString(),
    aspRoot: asp.root.toString(),
    nullifierHash: nullifierHash.toString(),
    newCommitment: newCommitment.toString(),
    context: context.toString(),
    value: value.toString(),
    label: label.toString(),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    newNullifier: newNullifier.toString(),
    newSecret: newSecret.toString(),
    stateSiblings: state.siblings.map((x) => x.toString()),
    stateIndex: state.indices.map((x) => x.toString()),
    aspSiblings: asp.siblings.map((x) => x.toString()),
    aspIndex: asp.indices.map((x) => x.toString()),
  };

  const expectedPublic = {
    withdrawnValue: withdrawnValue.toString(),
    stateRoot: state.root.toString(),
    aspRoot: asp.root.toString(),
    nullifierHash: nullifierHash.toString(),
    newCommitment: newCommitment.toString(),
    context: context.toString(),
  };

  // Invalid: tamper the public nullifierHash so the nh.out === nullifierHash
  // binding constraint is violated (witness generation must fail).
  const invalidInput = { ...validInput, nullifierHash: (nullifierHash + 1n).toString() };

  writeFileSync(resolve(FIXTURE_DIR, "valid-input.json"), JSON.stringify(validInput, null, 2));
  writeFileSync(resolve(FIXTURE_DIR, "invalid-input.json"), JSON.stringify(invalidInput, null, 2));
  writeFileSync(
    resolve(FIXTURE_DIR, "expected-public.json"),
    JSON.stringify(expectedPublic, null, 2),
  );
  console.log(`Wrote v3 fixtures to ${FIXTURE_DIR}`);
  console.log(`  commitment=${commitment}`);
  console.log(`  stateRoot=${state.root}`);
  console.log(`  aspRoot=${asp.root}`);
  console.log(`  newCommitment=${newCommitment}`);
}

main();
