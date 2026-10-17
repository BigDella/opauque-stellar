/**
 * The full end-to-end script from docs/integrate/private-payments.md, pulled
 * into the page by region and typechecked by `npm run typecheck:docs`.
 */
declare const RECIPIENT_SECRET: string;
declare const SENDER_SECRET: string;
declare const RECIPIENT_MAIN_ACCOUNT: string;
declare const recipientSignatureHex: string;

// #region full
import { OpaqueClient, keypairSigner, parseXlmToStroops } from "@opaquecash/stellar";

// --- recipient ---
const recipient = new OpaqueClient({ network: "testnet", signer: keypairSigner(RECIPIENT_SECRET) });
const id = recipient.payments.deriveIdentity(recipientSignatureHex);
await recipient.payments.register({ metaAddress: id.metaAddress });

// --- sender ---
const sender = new OpaqueClient({ network: "testnet", signer: keypairSigner(SENDER_SECRET) });
const sent = await sender.payments.send({ to: id.metaHex, amountXlm: "10" });
console.log("paid stealth account:", sent.stealthStellarAddress);

// --- recipient detects + sweeps ---
for await (const match of recipient.payments.scanIterator({ identity: id })) {
  if (match.stealthStellarAddress !== sent.stealthStellarAddress) continue;
  await recipient.payments.sweep({
    stealthPrivKey: match.stealthPrivKey,
    destination: RECIPIENT_MAIN_ACCOUNT,
    amountStroops: parseXlmToStroops("9.9"),
  });
  break; // stops the scan without reading further pages
}
// #endregion full
