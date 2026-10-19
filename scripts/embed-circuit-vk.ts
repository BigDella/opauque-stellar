/**
 * Generate the groth16-verifier embedded verification-key constants from a snarkjs
 * verification_key.json, and (optionally) rewrite them in place in the contract.
 *
 * Encoding (matches contracts/groth16-verifier/src/lib.rs + Soroban BN254 host fns):
 *   G1 point  -> [u8; 64]  = x(32B BE) || y(32B BE)
 *   G2 point  -> [u8; 128] = x_c1(32B) || x_c0(32B) || y_c1(32B) || y_c0(32B)   (EIP-197, imaginary first)
 *   IC        -> [[u8; 64]; n+1]  (one G1 per public signal, plus IC[0])
 *
 * snarkjs vk.json field layout:
 *   vk_alpha_1 = [x, y, z]                 (G1)
 *   vk_beta_2  = [[x_c0,x_c1],[y_c0,y_c1]] (G2)
 *   vk_gamma_2, vk_delta_2                 (G2)
 *   IC         = [[x,y,z], ...]            (G1[])
 *
 * Usage:
 *   tsx scripts/embed-circuit-vk.ts <vk.json> [--v2] [--write] [--lib <path>]
 *     (no --write: prints the Rust const blocks to stdout)
 */

import { readFileSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const positional = [];
  const opts = { v2: false, v3: false, write: false, lib: "contracts/groth16-verifier/src/lib.rs" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--v2") opts.v2 = true;
    else if (a === "--v3") opts.v3 = true;
    else if (a === "--write") opts.write = true;
    else if (a === "--lib") opts.lib = argv[++i];
    else positional.push(a);
  }
  if (!positional[0]) {
    console.error("usage: tsx scripts/embed-circuit-vk.ts <vk.json> [--v2] [--write] [--lib <path>]");
    process.exit(1);
  }
  opts.vk = positional[0];
  return opts;
}

/** decimal (or 0x) field element -> 32-byte big-endian array */
function be32(dec) {
  let hex = BigInt(dec).toString(16);
  if (hex.length > 64) throw new Error(`field element too large: ${dec}`);
  hex = hex.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** G1 [x,y,z] -> 64 bytes */
function g1(p) {
  return concat(be32(p[0]), be32(p[1]));
}

/** G2 [[x_c0,x_c1],[y_c0,y_c1],...] -> 128 bytes, c1 first */
function g2(p) {
  return concat(be32(p[0][1]), be32(p[0][0]), be32(p[1][1]), be32(p[1][0]));
}

/** format a flat byte array as Rust `0xNN, ...`, 16 per line, indented `indent` spaces */
function fmtBytes(bytes, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = Array.from(bytes.slice(i, i + 16))
      .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
      .join(", ");
    lines.push(`${pad}${row},`);
  }
  return lines.join("\n");
}

function constBlock(name, type, bytes) {
  return `const ${name}: ${type} = [\n${fmtBytes(bytes, 4)}\n];`;
}

function icBlock(name, points) {
  const inner = points
    .map((pt) => `    [\n${fmtBytes(pt, 8)}\n    ]`)
    .join(",\n");
  return `const ${name}: [[u8; 64]; ${points.length}] = [\n${inner},\n];`;
}

function replaceConst(source, name, typeRegex, block) {
  const re = new RegExp(`const ${name}: ${typeRegex} = \\[[\\s\\S]*?\\];`, "m");
  if (!re.test(source)) throw new Error(`Could not locate const ${name} in lib.rs`);
  return source.replace(re, block);
}

function main() {
  const opts = parseArgs(process.argv);
  const vk = JSON.parse(readFileSync(opts.vk, "utf8"));
  const suffix = opts.v3 ? "_V3" : opts.v2 ? "_V2" : "";

  const alpha = g1(vk.vk_alpha_1);
  const beta = g2(vk.vk_beta_2);
  const gamma = g2(vk.vk_gamma_2);
  const delta = g2(vk.vk_delta_2);
  const ic = vk.IC.map(g1);

  for (const [label, arr, len] of [
    ["alpha", alpha, 64],
    ["beta", beta, 128],
    ["gamma", gamma, 128],
    ["delta", delta, 128],
  ]) {
    if (arr.length !== len) throw new Error(`${label} encoded to ${arr.length} bytes, expected ${len}`);
  }
  for (const p of ic) if (p.length !== 64) throw new Error(`IC point not 64 bytes`);

  const blocks = {
    [`VK_ALPHA${suffix}`]: constBlock(`VK_ALPHA${suffix}`, "[u8; 64]", alpha),
    [`VK_BETA${suffix}`]: constBlock(`VK_BETA${suffix}`, "[u8; 128]", beta),
    [`VK_GAMMA${suffix}`]: constBlock(`VK_GAMMA${suffix}`, "[u8; 128]", gamma),
    [`VK_DELTA${suffix}`]: constBlock(`VK_DELTA${suffix}`, "[u8; 128]", delta),
    [`VK_IC${suffix}`]: icBlock(`VK_IC${suffix}`, ic),
  };

  if (!opts.write) {
    console.log(`// Generated from ${opts.vk} (${ic.length} IC points, ${ic.length - 1} public signals)\n`);
    console.log(Object.values(blocks).join("\n\n"));
    return;
  }

  let source = readFileSync(opts.lib, "utf8");
  source = replaceConst(source, `VK_ALPHA${suffix}`, "\\[u8; 64\\]", blocks[`VK_ALPHA${suffix}`]);
  source = replaceConst(source, `VK_BETA${suffix}`, "\\[u8; 128\\]", blocks[`VK_BETA${suffix}`]);
  source = replaceConst(source, `VK_GAMMA${suffix}`, "\\[u8; 128\\]", blocks[`VK_GAMMA${suffix}`]);
  source = replaceConst(source, `VK_DELTA${suffix}`, "\\[u8; 128\\]", blocks[`VK_DELTA${suffix}`]);
  source = replaceConst(source, `VK_IC${suffix}`, "\\[\\[u8; 64\\]; \\d+\\]", blocks[`VK_IC${suffix}`]);
  writeFileSync(opts.lib, source);
  console.log(`Embedded VK${suffix} (${ic.length} IC points) into ${opts.lib}. Run cargo fmt.`);
}

main();
