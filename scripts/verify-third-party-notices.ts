/**
 * Verify THIRD_PARTY_NOTICES.md matches the current dependency trees and
 * that every non-permissive-licensed (or unrecognized-license) dependency
 * has an explicit, reviewed entry (#470).
 *
 * Fails when:
 *   - THIRD_PARTY_NOTICES.md is missing or stale (regenerate with
 *     `npm run notices:generate` and commit the diff).
 *   - A dependency's license is not in PERMISSIVE_LICENSES and not an
 *     explicitly reviewed entry in REVIEWED_NON_PERMISSIVE — this is what
 *     makes a newly-added copyleft/unknown-license dependency fail CI
 *     instead of silently shipping unnoticed.
 *
 * Usage:
 *   npx tsx scripts/verify-third-party-notices.ts
 */

import { existsSync, readFileSync } from "node:fs";
import {
  NOTICES_PATH,
  REVIEWED_NON_PERMISSIVE,
  isPermissiveExpression,
  collectRustCrates,
  collectCircuitsToolchain,
  collectFrontendBundle,
  renderNotices,
} from "./third-party-notices-lib.ts";

function main() {
  const errors = [];

  const rust = collectRustCrates();
  const circuitsToolchain = collectCircuitsToolchain();
  const frontendBundle = collectFrontendBundle();
  const all = [...rust, ...circuitsToolchain, ...frontendBundle];

  for (const dep of all) {
    const permissive = isPermissiveExpression(dep.license);
    const reviewed = REVIEWED_NON_PERMISSIVE.get(dep.name);
    if (!permissive && !reviewed) {
      errors.push(
        `${dep.name}@${dep.version}: license "${dep.license ?? "unknown"}" is not in the permissive ` +
          `allow list and has no reviewed entry in scripts/third-party-notices-lib.ts ` +
          `(REVIEWED_NON_PERMISSIVE). Add one with a justification, or drop the dependency.`,
      );
    } else if (reviewed && reviewed.license !== dep.license) {
      errors.push(
        `${dep.name}@${dep.version}: reviewed entry expects license "${reviewed.license}" but found ` +
          `"${dep.license}". Re-review before accepting the license change.`,
      );
    }
  }

  const expected = renderNotices();
  if (!existsSync(NOTICES_PATH)) {
    errors.push(`${NOTICES_PATH} does not exist. Run: npm run notices:generate`);
  } else {
    const actual = readFileSync(NOTICES_PATH, "utf8");
    if (actual !== expected) {
      errors.push(
        "THIRD_PARTY_NOTICES.md is out of date with the current dependency trees. " +
          "Run: npm run notices:generate — then commit the diff.",
      );
    }
  }

  if (errors.length > 0) {
    console.error("Third-party notices verification failed:\n");
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  console.log(`OK: THIRD_PARTY_NOTICES.md is current (${all.length} bundled dependencies checked)`);
}

main();
