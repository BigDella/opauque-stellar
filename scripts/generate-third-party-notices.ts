/**
 * Regenerate THIRD_PARTY_NOTICES.md from the current Rust + npm dependency
 * trees (#470). Run after adding, removing, or upgrading a dependency that
 * ships in on-chain contract WASM, the scanner WASM, the circuits build
 * toolchain, or the frontend production bundle.
 *
 * Requires node_modules installed in circuits/ and frontend/ (npm ci).
 *
 * Usage:
 *   npx tsx scripts/generate-third-party-notices.ts
 */

import { writeFileSync } from "node:fs";
import { NOTICES_PATH, renderNotices } from "./third-party-notices-lib.ts";

writeFileSync(NOTICES_PATH, renderNotices());
console.log(`Wrote ${NOTICES_PATH}`);
