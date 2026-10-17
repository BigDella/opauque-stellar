/**
 * Code examples for docs/integrate/custodial-platforms.md, pulled into the page
 * by region. `@opaquecash/stellar` resolves to the package's public entry point
 * (see tsconfig.docs.json), so an example that reaches for an unexported helper
 * fails `npm run typecheck:docs`.
 */
import {
  EventTruncationError,
  OpaqueClient,
  scanCursorKey,
  type ScanMatch,
  type StealthIdentity,
} from "@opaquecash/stellar";

declare const opaque: OpaqueClient;
declare const identity: StealthIdentity;
declare function creditDeposit(match: ScanMatch & { ledger: number }): Promise<void>;

// #region scan
async function detectDeposits(
  opaque: OpaqueClient,
  identity: StealthIdentity,
  onDeposit: (match: ScanMatch & { ledger: number }) => Promise<void>,
): Promise<void> {
  // First run: start at the contracts' deployment ledger instead of the
  // default lookback window. Later runs resume from the persisted cursor.
  const saved = await opaque.scanStore.getCursor(scanCursorKey(identity));
  let startLedger = saved == null ? opaque.config.startLedger : undefined;

  for (;;) {
    try {
      // Pages over quiet ledger ranges come back empty; the iterator keeps
      // following the RPC cursor through them until the event range drains.
      for await (const match of opaque.payments.scanIterator({ identity, startLedger })) {
        await onDeposit(match);
      }
      return; // read through the end of the event range
    } catch (err) {
      // The page cap stopped this pass with events still unread. The cursor
      // was persisted at the last fully-read page, so pick up from there.
      if (!(err instanceof EventTruncationError)) throw err;
      startLedger = undefined;
    }
  }
}

await detectDeposits(opaque, identity, creditDeposit);
// #endregion scan
