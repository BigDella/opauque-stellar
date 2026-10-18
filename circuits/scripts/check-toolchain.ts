/**
 * Preflight toolchain verification for circuit builds (issue #601).
 *
 * Circuit artifacts (R1CS, WASM witness generators, zkeys) depend on the
 * exact circom and snarkjs versions used to produce them — a version
 * mismatch can silently produce a build that isn't byte-compatible with the
 * pinned artifacts even when compilation succeeds and existing tests still
 * pass locally. This script fails fast, before any build step runs, when the
 * locally installed circom, snarkjs, or Node major version doesn't match
 * circuits/TOOLCHAIN.json.
 *
 * Run: node circuits/scripts/check-toolchain.ts   (also wired as `npm run
 * check:toolchain` in circuits/package.json, and invoked from the top-level
 * `npm run test:circuits` --compile path before any compile step).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLCHAIN_PATH = join(__dirname, "..", "TOOLCHAIN.json");

interface ToolchainPin {
  circom: string;
  snarkjs: string;
  nodeMajor: number;
}

function loadPins(): ToolchainPin {
  const raw = readFileSync(TOOLCHAIN_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return { circom: parsed.circom, snarkjs: parsed.snarkjs, nodeMajor: parsed.nodeMajor };
}

function tryRun(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Extracts the first x.y.z (or x.y) version substring from arbitrary CLI output. */
function extractVersion(output: string | null): string | null {
  if (!output) return null;
  const match = output.match(/\d+\.\d+(?:\.\d+)?/);
  return match ? match[0] : null;
}

function checkCircom(pinned: string): { ok: boolean; message: string } {
  const output = tryRun("circom", ["--version"]);
  const actual = extractVersion(output);
  if (actual === null) {
    return {
      ok: false,
      message:
        `circom not found on PATH (expected ${pinned}). Install: ` +
        `https://docs.circom.io/getting-started/installation/`,
    };
  }
  if (actual !== pinned) {
    return {
      ok: false,
      message: `circom version mismatch: expected ${pinned}, found ${actual}. ` +
        `Reinstall the pinned version before building — a mismatched circom can produce ` +
        `artifacts that silently diverge from the committed build.`,
    };
  }
  return { ok: true, message: `circom ${actual} matches pinned ${pinned}` };
}

function checkSnarkjs(pinned: string): { ok: boolean; message: string } {
  // snarkjs's own `--version` flag is unreliable across releases; the
  // package.json devDependency version is the source of truth we build
  // against, so compare against that instead of shelling out.
  let installed: string | null = null;
  try {
    const pkgPath = join(__dirname, "..", "node_modules", "snarkjs", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    installed = pkg.version ?? null;
  } catch {
    installed = null;
  }
  if (installed === null) {
    return {
      ok: false,
      message: `snarkjs not found in circuits/node_modules (expected ${pinned}). Run \`npm install\` in circuits/.`,
    };
  }
  if (installed !== pinned) {
    return {
      ok: false,
      message: `snarkjs version mismatch: expected ${pinned}, found ${installed}. ` +
        `Run \`npm install\` in circuits/ to sync with the pinned devDependency, then re-verify ` +
        `this check passes before building.`,
    };
  }
  return { ok: true, message: `snarkjs ${installed} matches pinned ${pinned}` };
}

function checkNode(pinnedMajor: number): { ok: boolean; message: string } {
  const actualMajor = Number(process.versions.node.split(".")[0]);
  if (actualMajor !== pinnedMajor) {
    return {
      ok: false,
      message: `Node major version mismatch: expected ${pinnedMajor}.x, found ${process.version}. ` +
        `Switch to Node ${pinnedMajor} (e.g. via nvm) before building circuits.`,
    };
  }
  return { ok: true, message: `Node ${process.version} matches pinned major ${pinnedMajor}` };
}

function main(): void {
  const pins = loadPins();
  const results = [
    checkCircom(pins.circom),
    checkSnarkjs(pins.snarkjs),
    checkNode(pins.nodeMajor),
  ];

  let allOk = true;
  for (const result of results) {
    console.log(`${result.ok ? "OK" : "FAIL"}: ${result.message}`);
    if (!result.ok) allOk = false;
  }

  if (!allOk) {
    console.error(
      "\nToolchain check failed — see circuits/TOOLCHAIN.json for the pinned versions " +
        "and circuits/README.md#build--setup for install instructions. Aborting before any build step.",
    );
    process.exit(1);
  }

  console.log("\nToolchain OK — safe to build.");
}

main();
