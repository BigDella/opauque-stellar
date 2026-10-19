/**
 * Generates the SDK error code mapping from Rust contract source files.
 *
 * Parses `#[contracterror]` enums from each contract's lib.rs and writes
 * a TypeScript mapping file. Fails if a contract has no error enum or if
 * the generated output differs from the checked-in file (CI gate).
 *
 * Usage:
 *   npx tsx scripts/generate-error-mapping.ts
 *   npx tsx scripts/generate-error-mapping.ts --check   # CI mode: fail on drift
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONTRACTS_DIR = join(ROOT, "contracts");
const OUTPUT = join(ROOT, "sdk", "src", "errors", "contract-errors.generated.ts");

// Contract package name → directory name under contracts/
const CONTRACT_PACKAGES: Record<string, string> = {
  "groth16-verifier": "groth16-verifier",
  "privacy-pool": "privacy-pool",
  "reputation-verifier": "reputation-verifier",
  "attestation-engine-v2": "attestation-engine-v2",
  "schema-registry": "schema-registry",
  "relayer-registry": "relayer-registry",
  "stealth-announcer": "stealth-announcer",
  "stealth-registry": "stealth-registry",
};

interface ErrorVariant {
  name: string;
  code: number;
}

function parseContractErrors(source: string): ErrorVariant[] {
  // Find the #[contracterror] enum block.
  const match = source.match(
    /#\[contracterror\][\s\S]*?pub\s+enum\s+\w+\s*\{([\s\S]*?)\}/,
  );
  if (!match) return [];

  const body = match[1];
  const variants: ErrorVariant[] = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // Match: VariantName = N,
    const variantMatch = trimmed.match(/^(\w+)\s*=\s*(\d+)\s*,?\s*$/);
    if (variantMatch) {
      variants.push({
        name: variantMatch[1],
        code: parseInt(variantMatch[2], 10),
      });
    }
  }

  return variants;
}

function generateMapping(
  entries: Map<string, ErrorVariant[]>,
): string {
  const lines = [
    "/**",
    " * Canonical error code mapping for all Soroban contracts.",
    " *",
    " * GENERATED FILE — do not edit manually. Run:",
    " *   npx tsx scripts/generate-error-mapping.ts",
    " *",
    " * Source of truth: each contract's `#[contracterror]` enum in Rust.",
    " * Removing or renumbering a code in the Rust source without updating this",
    " * file will cause the generate script to fail, keeping SDK and contracts",
    " * in sync.",
    " */",
    "",
    "export const CONTRACT_ERROR_NAMES: Record<string, Record<number, string>> = {",
  ];

  for (const [pkg, variants] of entries) {
    if (variants.length === 0) continue;
    lines.push(`  "${pkg}": {`);
    for (const v of variants) {
      lines.push(`    ${v.code}: "${v.name}",`);
    }
    lines.push("  },");
  }

  lines.push("};");
  lines.push("");

  return lines.join("\n");
}

function main() {
  const checkMode = process.argv.includes("--check");
  const errors: string[] = [];
  const entries = new Map<string, ErrorVariant[]>();

  for (const [pkg, dir] of Object.entries(CONTRACT_PACKAGES)) {
    const libPath = join(CONTRACTS_DIR, dir, "src", "lib.rs");
    if (!existsSync(libPath)) {
      errors.push(`Contract source not found: ${libPath}`);
      continue;
    }

    const source = readFileSync(libPath, "utf-8");
    const variants = parseContractErrors(source);

    if (variants.length === 0) {
      errors.push(`No #[contracterror] enum found in ${pkg}`);
      continue;
    }

    // Validate: codes must be sequential starting at 1.
    for (let i = 0; i < variants.length; i++) {
      if (variants[i].code !== i + 1) {
        errors.push(
          `${pkg}: error code ${variants[i].code} at position ${i} (expected ${i + 1})`,
        );
      }
    }

    entries.set(pkg, variants);
  }

  if (errors.length > 0) {
    console.error("Error code validation failed:");
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  const output = generateMapping(entries);

  if (checkMode) {
    const existing = readFileSync(OUTPUT, "utf-8");
    if (existing !== output) {
      console.error(
        "Generated error mapping differs from checked-in file. Run:\n  npx tsx scripts/generate-error-mapping.ts",
      );
      process.exit(1);
    }
    console.log("Error mapping is up to date.");
  } else {
    writeFileSync(OUTPUT, output);
    console.log(`Generated ${OUTPUT}`);
  }
}

main();
