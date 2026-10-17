/**
 * Code examples for docs/integrate/private-payments.md, pulled into the page by
 * region. `@opaquecash/stellar` resolves to the package's public entry point
 * (see tsconfig.docs.json), so an example that reaches for an unexported helper
 * fails `npm run typecheck:docs`.
 */
import {
  OpaqueClient,
  type ScanMatch,
  type StealthAnnouncement,
  type StealthIdentity,
} from "@opaquecash/stellar";

declare const opaque: OpaqueClient;
declare const identity: StealthIdentity;

// #region scan
// Reads stealth-announcer events from chain, matches them against the
// recipient's keys (view-tag prefilter, reconstruct, confirm by stealth id),
// and yields each match as soon as its page is read.
const matches: ScanMatch[] = [];
for await (const m of opaque.payments.scanIterator({ identity })) {
  console.log("incoming transfer at", m.stealthStellarAddress, "in ledger", m.ledger);
  // m.stealthPrivKey — the one-time key controlling those funds
  matches.push(m);
}
// #endregion scan

// #region fetch
async function fetchAnnouncements(
  opaque: OpaqueClient,
  startLedger?: number,
): Promise<StealthAnnouncement[]> {
  const announcements: StealthAnnouncement[] = [];
  // One page per getEvents response. A page over a quiet ledger range has no
  // announcements but is not the end — keep going until the scan drains.
  for await (const page of opaque.contracts.stealthAnnouncer.scanEvents({
    startLedger,
    throwOnTruncation: true,
  })) {
    announcements.push(...page.announcements);
  }
  return announcements;
}

const announcements = await fetchAnnouncements(opaque, opaque.config.startLedger);
const found = opaque.payments.scan({ announcements, identity });
// #endregion fetch

void found;
