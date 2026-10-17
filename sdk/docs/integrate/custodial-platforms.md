# Integrate: Custodial Platforms

A quickstart for exchanges, custodial wallets, and other platforms that hold
user funds and want to detect incoming stealth payments in bulk and pay users
out privately — from install to your first private payout. Builds on
[Private Payments](/integrate/private-payments); read that first for the
underlying stealth-address model.

If your platform also wants to let users deposit into and withdraw from the
shielded [Privacy Pool](/integrate/privacy-pool), read that guide too — the
association-set and compliance implications below are specific to the pool,
not to plain stealth payments.

## Prerequisites

```sh
npm install @opaquecash/stellar "@stellar/stellar-sdk" "@noble/curves@^1" "@noble/hashes@^1"
```

You do not need `circomlibjs`/`snarkjs`/an `ArtifactResolver` unless you also
integrate the privacy pool or ZK reputation — plain stealth receiving and
sending needs no proving.

```ts
import { OpaqueClient, keypairSigner, callbackSigner } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.PAYOUT_SECRET!), // see "Key custody" below
});
```

## Step 1 — Derive and register your platform's own receiving identity

If your platform is itself a *recipient* (e.g. users deposit to your
exchange), derive one stealth identity for your platform once, the same way
any recipient does — see [Private Payments § Step 1](/integrate/private-payments).
Persist the signature or the derived keys (encrypted); re-deriving requires
the exact same signature.

```ts
const identity = opaque.payments.deriveIdentity(operationalSignatureHex);
await opaque.payments.register({ metaAddress: identity.metaAddress });
// share identity.metaHex with your users as your deposit address
```

## Step 2 — Detect incoming deposits in bulk (batch receiving)

`payments.scanIterator()` reads the stealth-announcer's events from chain page
by page, matches each whole page against your identity in one pass, and yields
every deposit as soon as its page is read:

<<< @/snippets/custodial-platforms.ts#scan

Soroban RPC can hand back empty event pages before the ones holding events, so
an empty page is never the end of the scan: the iterator keeps following the
RPC cursor until the event range drains, and only then does the `for await`
finish. A pass that hits the page cap throws `EventTruncationError` rather
than ending as if it were complete; the loop above resumes it from the cursor
saved at the last fully-read page.

The iterator persists its cursor to the client's `ScanStore` after every page,
quiet ones included, so a periodic job only processes new ledgers, not the full
history every time. The default store is in-memory; pass a persistent one
(`new OpaqueClient({ ..., storage: { scan: myScanStore } })`) for a job that
restarts. A crash mid-page re-yields that page's matches on the next run, so
make `onDeposit` idempotent (key credits by `match.stealthStellarAddress`).

There is currently no on-chain batch primitive (no batch nullifier-check or
batch-balance contract call) — the scan batches the client-side matching step,
not a chain round-trip. Plan your polling interval and `maxPages` cap around
Soroban RPC's own event-query limits, not around an Opaque-specific batch API.

## Step 3 — Pay users out privately

Resolve the recipient's `metaHex` (from your own records at registration
time, or a fresh on-chain lookup) and call `send` once per payout:

```ts
const result = await opaque.payments.send({
  to: recipientMetaHex,
  amountXlm: payoutAmount,
});
// result.stealthStellarAddress — the one-time account the recipient controls
// result.paymentTxHash / result.announceTxHash
```

Each call derives a fresh, unlinkable destination — repeated payouts to the
same user never share an on-chain address. There is no batch-send contract
entrypoint today: issue a payout run as N `send()` calls, parallelized with a
concurrency limit appropriate to your RPC provider's rate limits, not as a
single bundled transaction.

That's install → derive/register → batch-detect → pay out: the full flow to
your first private payout.

## Association set and policy implications

This matters only if you also integrate the **privacy pool** — plain stealth
sends/receives (steps 1–3 above) never touch the Association Set Provider.

- **The ASP gates pool withdrawal eligibility, not custody.** It cannot mint,
  steal, or redirect funds — the `privacy-pool` contract independently
  enforces a custody invariant (aggregate withdrawals can never exceed
  aggregate deposits) regardless of what the ASP publishes. The ASP only
  decides whether a given deposit is a member of the *approved set* that
  withdrawal proofs must prove membership in.
- **The shipped default policy approves every deposit.** The reference ASP's
  policy is `approveAll` — every testnet deposit is currently in the approved
  set. A `screeningPolicy` hook for real sanctions/risk screening exists in
  the ASP's source but is not the running default. Do not describe pool
  deposits as being actively screened today; describe it as an
  operator-configurable capability.
- **Exclusion does not freeze funds.** If a deposit is ever excluded from the
  approved set (under a stricter policy than the default), the funds are not
  lost — they remain recoverable via direct stealth-key withdrawal,
  immediately, with no operator involvement. Only *pool* withdrawal proof
  generation is blocked for that specific deposit. See the
  [exclusion and appeal process](https://github.com/collinsadi/opaque-stellar/blob/main/docs/EXCLUSION_APPEAL_PROCESS.md)
  — note its appeal channel is currently a draft/placeholder with no firm
  SLA; don't present it to your users as a guaranteed compliance workflow.
- **You still need your own AML/travel-rule tooling.** Nothing in this
  protocol implements travel-rule reporting or sanctions screening for you —
  that's entirely your platform's responsibility, the same as any other
  withdrawal.
- **Unlinkability strength depends on pool activity, not a protocol
  guarantee.** A withdrawal's anonymity set is bounded by how many other
  deposits share the current published root at the time you withdraw — wait
  for a larger association set before withdrawing when unlinkability matters,
  the same guidance the reference wallet gives its own users.
- **If you run a relayer for your users**, its job-funding transaction is
  public and signed by whichever wallet escrows the fee — fund it from an
  address not linked to your platform's main identity, or the funding step
  itself becomes the linkage the relayer was meant to avoid. See
  [Relayer Market](/integrate/relayer-market).

## Key custody patterns

- **Choose your signer deliberately.** `keypairSigner` holds a raw secret key
  in process memory — use it only on a server, never in a browser context.
  For HSM-backed or external signing services (including a wallet you don't
  control the key material of), use `callbackSigner({ publicKey,
  signTransaction })` — the SDK never sees the key, only signed envelopes.
- **Your platform's receiving identity's spending key is the one that
  matters most.** `deriveIdentity` gives you `viewingKey` (detects deposits)
  and `spendingKey` (moves them) — treat `spendingKey` with the same
  operational rigor as any hot withdrawal key, since anyone who obtains it
  can sweep every stealth deposit your platform has received. Persisting the
  wallet signature used to derive it is equivalent to persisting the key
  itself; encrypt it at rest.
- **If you integrate the privacy pool, your `NoteStore` is spending
  material.** "Losing a note loses the funds" — the SDK's own words. The
  default `NoteStore` is in-memory only and unsuitable for production; wire a
  persistent, encrypted, backed-up store via the client's `storage.notes`
  option before handling real value.
- **You never need your users' private keys.** A user's viewing/spending keys
  are derived and held entirely client-side; your platform only ever needs
  their public `metaHex` to pay them. There is no recipient key material for
  you to custody, transmit, or lose on their behalf.

## Troubleshooting

If proof generation or on-chain verification fails (relevant once you
integrate the privacy pool or ZK reputation), see
[Troubleshooting Proof Generation Failures](https://github.com/collinsadi/opaque-stellar/blob/main/docs/TROUBLESHOOTING_PROOF_GENERATION.md).
