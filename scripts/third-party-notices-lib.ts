/**
 * Shared logic for generating and verifying THIRD_PARTY_NOTICES.md (#470).
 *
 * Scope is deliberately narrow: the license obligations that ship in a
 * *binary artifact* this repo distributes — the Rust crates compiled into
 * on-chain contract WASM and the scanner WASM, the circom/snarkjs toolchain
 * whose *output* (r1cs/witness-WASM/zkey) is bundled under
 * frontend/public/circuits/ and embedded in the on-chain verifier, and the
 * npm packages the frontend ships in its production browser bundle. Broader
 * license auditing across every workspace (sdk/relayer/asp source
 * dependencies that never ship a compiled artifact) is out of scope here —
 * see issue #148 for that wider tracking scope.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const NOTICES_PATH = join(ROOT, "THIRD_PARTY_NOTICES.md");

// Permissive licenses that ship without requiring an individual notice
// entry beyond the listing itself. Mirrors deny.toml's [licenses].allow
// list for Rust; extended with the equivalents commonly seen in the npm
// dependency trees scanned here. Keep these two lists in sync when either
// changes.
export const PERMISSIVE_LICENSES = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "Unicode-DFS-2016",
  "Unicode-3.0",
  "Python-2.0",
  "BlueOak-1.0.0",
  "WTFPL",
  "OFL-1.1",
  "CC-BY-4.0",
  "Unlicense",
  "Zlib",
  // Weak (file-level) copyleft: only triggers if you modify and redistribute
  // the MPL-covered file itself. Safe for unmodified use as a library
  // dependency, unlike GPL/AGPL/LGPL — treated as permissive here as most
  // projects do, rather than requiring a per-package reviewed entry.
  "MPL-2.0",
  // Legacy, non-SPDX shorthand still seen in older npm packages (e.g.
  // esprima) that in practice always resolves to a 2- or 3-clause BSD text.
  "BSD",
]);

/**
 * Parses a (possibly compound) SPDX-ish license expression and reports
 * whether it's permissive. Handles the shapes actually seen across this
 * repo's Rust + npm dependency trees: a bare id, "A OR B" / legacy "A/B"
 * (any acceptable alternative is enough), "A AND B" (every term must be
 * individually acceptable), and one layer of wrapping parens.
 */
export function isPermissiveExpression(expr) {
  if (!expr) return false;
  const cleaned = expr.trim().replace(/^\(+|\)+$/g, "").trim();
  if (PERMISSIVE_LICENSES.has(cleaned)) return true;
  if (/\bAND\b/.test(cleaned)) {
    return cleaned.split(/\s+AND\s+/).every((part) => isPermissiveExpression(part));
  }
  if (/\bOR\b/.test(cleaned)) {
    return cleaned.split(/\s+OR\s+/).some((part) => isPermissiveExpression(part));
  }
  if (cleaned.includes("/")) {
    return cleaned.split("/").some((part) => isPermissiveExpression(part));
  }
  return false;
}

// Non-permissive or unrecognized licenses that have been explicitly
// reviewed and are knowingly accepted, each with why. Adding a *new*
// package here is a deliberate, reviewed decision — that review gate is
// the actual protection this check provides. A dependency whose license
// is neither in PERMISSIVE_LICENSES nor listed here fails verification.
//
// circomlib, circomlibjs, and snarkjs (plus snarkjs's own GPL-3.0 iden3
// dependencies below) are GPL-3.0. circomlib's templates are compiled
// directly into the circuit artifacts (r1cs, witness WASM, zkey) this repo
// distributes under frontend/public/circuits/ and embeds in the on-chain
// groth16-verifier; snarkjs and circomlibjs run as separate, dynamically-
// loaded modules in the browser to generate proofs client-side rather than
// being statically linked into the MIT-licensed application code. This
// repo's full corresponding source (this application, plus the unmodified
// upstream iden3 source) is publicly available, which is the operative
// GPL-3.0 obligation for a source distribution. This is a legal
// characterization, not a settled fact — flag any change to how these are
// consumed (e.g. statically linking one into a compiled binary rather than
// loading it as an independent module) for legal re-review before merging.
const IDEN3_TOOLCHAIN_JUSTIFICATION =
  "Part of the iden3 circom/snarkjs GPL-3.0 toolchain (transitive dependency of circomlib/circomlibjs/" +
  "snarkjs) — used at circuit build time and, via snarkjs in the frontend, as a dynamically-loaded " +
  "browser module for client-side proof generation, not statically linked into the MIT-licensed " +
  "application bundle. Full source (this repo + upstream) is public.";

export const REVIEWED_NON_PERMISSIVE = new Map([
  [
    "circomlib",
    {
      license: "GPL-3.0",
      justification:
        "Circom template library. Only its templates are compiled into the circuit artifacts " +
        "(r1cs / witness WASM / zkey) built at circuits/**; the npm package itself is a build-time " +
        "devDependency, never shipped. Full source (this repo + upstream) is public.",
    },
  ],
  [
    "circomlibjs",
    {
      license: "GPL-3.0",
      justification:
        "JS reimplementation of circomlib primitives (e.g. Poseidon) used at circuit build/fixture " +
        "time and, in the frontend, as a dynamically-loaded browser module for client-side proof " +
        "generation — not statically linked into the MIT-licensed application bundle. Full source " +
        "(this repo + upstream) is public.",
    },
  ],
  [
    "snarkjs",
    {
      license: "GPL-3.0",
      justification:
        "Groth16 setup/proving toolkit used at circuit build time and, in the frontend, as a " +
        "dynamically-loaded browser module for client-side proof generation — not statically linked " +
        "into the MIT-licensed application bundle. Full source (this repo + upstream) is public.",
    },
  ],
  // Transitive GPL-3.0 dependencies of snarkjs/circomlibjs (all iden3 packages).
  ["@iden3/bigarray", { license: "GPL-3.0", justification: IDEN3_TOOLCHAIN_JUSTIFICATION }],
  ["@iden3/binfileutils", { license: "GPL-3.0", justification: IDEN3_TOOLCHAIN_JUSTIFICATION }],
  ["fastfile", { license: "GPL-3.0", justification: IDEN3_TOOLCHAIN_JUSTIFICATION }],
  ["ffjavascript", { license: "GPL-3.0", justification: IDEN3_TOOLCHAIN_JUSTIFICATION }],
  ["r1csfile", { license: "GPL-3.0", justification: IDEN3_TOOLCHAIN_JUSTIFICATION }],
  ["wasmbuilder", { license: "GPL-3.0", justification: IDEN3_TOOLCHAIN_JUSTIFICATION }],
  ["wasmcurves", { license: "GPL-3.0", justification: IDEN3_TOOLCHAIN_JUSTIFICATION }],
]);

function runJson(cmd, args, cwd) {
  const out = execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

/** Rust crates compiled into on-chain contract WASM + the scanner WASM. */
export function collectRustCrates() {
  const crates = new Map(); // key: `${name}@${version}` -> { name, version, license }

  for (const cwd of [ROOT, join(ROOT, "scanner")]) {
    const metadata = runJson("cargo", ["metadata", "--format-version", "1"], cwd);
    for (const pkg of metadata.packages) {
      if (pkg.source == null) continue; // workspace-local crate, not a third-party dep
      const key = `${pkg.name}@${pkg.version}`;
      if (crates.has(key)) continue;
      crates.set(key, {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? pkg.license_file ?? null,
      });
    }
  }

  return [...crates.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * Indexes every installed package.json under a node_modules tree by
 * name -> version -> license, recursing into nested node_modules (npm
 * nests a package instead of hoisting it whenever two dependents need
 * different versions, so a flat top-level lookup misses those).
 */
function buildLicenseIndex(nodeModulesDir) {
  const index = new Map(); // name -> Map(version -> license)

  function indexPackageDir(name, pkgDir) {
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) return;
    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch {
      return;
    }
    if (!pkgJson.version) return;
    const license =
      pkgJson.license ??
      (Array.isArray(pkgJson.licenses) ? pkgJson.licenses.map((l) => l.type ?? l).join(" OR ") : null);
    if (!index.has(name)) index.set(name, new Map());
    if (!index.get(name).has(pkgJson.version)) index.get(name).set(pkgJson.version, license);
  }

  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const full = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        let scoped;
        try {
          scoped = readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const s of scoped) {
          if (!s.isDirectory()) continue;
          const pkgDir = join(full, s.name);
          indexPackageDir(`${entry.name}/${s.name}`, pkgDir);
          const nested = join(pkgDir, "node_modules");
          if (existsSync(nested)) visit(nested);
        }
        continue;
      }
      indexPackageDir(entry.name, full);
      const nested = join(full, "node_modules");
      if (existsSync(nested)) visit(nested);
    }
  }

  visit(nodeModulesDir);
  return index;
}

/** npm production dependency tree for a workspace, using its installed node_modules. */
function collectNpmDeps(workspaceDir, { prodOnly }) {
  const nodeModulesDir = join(workspaceDir, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    throw new Error(
      `${workspaceDir} has no node_modules — run npm ci there before generating/verifying notices`,
    );
  }

  // --omit=optional drops platform-specific optional binaries (esbuild/rollup
  // native builds, fsevents, ...) that npm ls otherwise lists for every
  // target platform regardless of which one actually installed — without
  // this, the generated notices differ depending on which OS ran the
  // generator. None of them ship in a distributed artifact anyway.
  const args = ["ls", "--all", "--omit=optional", "--json"];
  if (prodOnly) args.push("--omit=dev");
  // npm ls exits non-zero on peer-dep/version-conflict warnings even when the
  // tree it printed is fine for our purposes; we only need the JSON it wrote.
  let raw;
  try {
    raw = execFileSync("npm", args, { cwd: workspaceDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    raw = err.stdout?.toString();
    if (!raw) throw err;
  }
  const tree = JSON.parse(raw);
  const licenseIndex = buildLicenseIndex(nodeModulesDir);

  const deps = new Map(); // key: `${name}@${version}` -> { name, version, license }

  function walk(node) {
    for (const [name, info] of Object.entries(node.dependencies ?? {})) {
      if (info.version) {
        const key = `${name}@${info.version}`;
        if (!deps.has(key)) {
          const license = licenseIndex.get(name)?.get(info.version) ?? null;
          deps.set(key, { name, version: info.version, license });
        }
      }
      walk(info);
    }
  }
  walk(tree);

  return [...deps.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** circom/snarkjs/circomlib toolchain — devDependencies, since its *output* ships, not the package. */
export function collectCircuitsToolchain() {
  return collectNpmDeps(join(ROOT, "circuits"), { prodOnly: false });
}

/** Production dependencies bundled into the frontend's shipped browser build. */
export function collectFrontendBundle() {
  return collectNpmDeps(join(ROOT, "frontend"), { prodOnly: true });
}

function classify(license) {
  if (isPermissiveExpression(license)) return "permissive";
  return "review";
}

function renderTable(rows) {
  if (rows.length === 0) return "_None._\n";
  const lines = ["| Package | Version | License |", "|:--------|:--------|:--------|"];
  for (const r of rows) {
    lines.push(`| ${r.name} | ${r.version} | ${r.license ?? "_unknown_"} |`);
  }
  return `${lines.join("\n")}\n`;
}

function renderReviewSection(allEntries) {
  const flagged = allEntries.filter((e) => classify(e.license) === "review");
  if (flagged.length === 0) return "_None currently flagged._\n";

  const lines = [];
  for (const entry of flagged) {
    const reviewed = REVIEWED_NON_PERMISSIVE.get(entry.name);
    lines.push(`### \`${entry.name}\` (${entry.version}) — ${entry.license ?? "unknown license"}\n`);
    if (reviewed) {
      lines.push(`${reviewed.justification}\n`);
    } else {
      lines.push(
        "**UNREVIEWED.** This package's license is not in the permissive allow list and has not " +
          "been explicitly reviewed in `scripts/third-party-notices-lib.ts`. `npm run notices:verify` " +
          "fails until a maintainer adds a reviewed entry (or removes the dependency).\n",
      );
    }
  }
  return lines.join("\n");
}

/** Builds the exact THIRD_PARTY_NOTICES.md content. Used by both generate and verify so they can never drift. */
export function renderNotices() {
  const rust = collectRustCrates();
  const circuitsToolchain = collectCircuitsToolchain();
  const frontendBundle = collectFrontendBundle();
  const all = [...rust, ...circuitsToolchain, ...frontendBundle];

  return `# Third-Party Notices

This file is auto-generated by \`npm run notices:generate\` — do not hand-edit it.
It covers the third-party code whose *compiled or bundled output* this repo
distributes: the Rust crates built into the on-chain contract WASM and the
scanner WASM, the circom/snarkjs/circomlib toolchain whose output (r1cs,
witness WASM, zkey) ships under \`frontend/public/circuits/\` and is embedded
in the on-chain verifier, and the npm packages bundled into the frontend's
production build. It does not enumerate every dependency of every workspace
in this repo — see issue #148 for that broader compliance tracking scope.

Regenerate after adding, removing, or upgrading a dependency in any of the
scopes above:

\`\`\`bash
npm run notices:generate
\`\`\`

\`npm run notices:verify\` (run in CI via
\`.github/workflows/license-compliance.yml\`) fails if this file is out of
date, or if a dependency's license is neither in the permissive allow list
nor an explicitly reviewed entry below — see \`PERMISSIVE_LICENSES\` and
\`REVIEWED_NON_PERMISSIVE\` in \`scripts/third-party-notices-lib.ts\`.

## Packages requiring explicit review (non-permissive or unrecognized license)

${renderReviewSection(all)}

## Rust crates (contracts + scanner workspaces)

Compiled into the on-chain contract WASM (\`contracts/\`) and the scanner WASM
(\`scanner/\`). License-allowed set is additionally enforced by \`cargo deny
check licenses\` against \`deny.toml\`.

${renderTable(rust)}

## circom / snarkjs toolchain (\`circuits/\`)

Build-time tooling whose *output* — not the npm packages themselves — is
bundled under \`frontend/public/circuits/\` and embedded in the on-chain
groth16-verifier.

${renderTable(circuitsToolchain)}

## Frontend production bundle (\`frontend/\`)

Shipped in the built browser application.

${renderTable(frontendBundle)}
`;
}
