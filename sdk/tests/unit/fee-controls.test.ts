/**
 * Fee bump and max-fee controls (issue #1172).
 *
 * `buildFeeBumpXdr` wraps a signed inner transaction in a bump envelope
 * offline; the exported helper is what `OpaqueClient.feeBumpTransaction`
 * signs and submits.
 */
import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { buildFeeBumpXdr, RpcError } from "../../src/index";

const PASSPHRASE = Networks.TESTNET;

function buildInnerXdr(fee: string = BASE_FEE): string {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), "1000");
  return new TransactionBuilder(account, { fee, networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(0)
    .build()
    .toXDR();
}

describe("buildFeeBumpXdr (#1172)", () => {
  it("wraps a signed inner transaction in a fee-bump envelope", () => {
    const feeSource = new Account(Keypair.random().publicKey(), "4242");
    const inner = buildInnerXdr();

    const bumpXdr = buildFeeBumpXdr({
      feeSource,
      feePerOperation: "5000",
      innerTransactionXdr: inner,
      networkPassphrase: PASSPHRASE,
    });

    expect(typeof bumpXdr).toBe("string");
    expect(bumpXdr.length).toBeGreaterThan(0);
    expect(bumpXdr).not.toEqual(inner);

    // The bump carries the raised fee and the original inner transaction.
    const parsed = TransactionBuilder.fromXDR(bumpXdr, PASSPHRASE) as {
      fee: string;
      innerTransaction?: { fee: string };
    };
    expect(parsed.innerTransaction?.fee ?? parsed.fee).toContain("5000");
  });

  it("accepts a numeric fee per operation", () => {
    const feeSource = new Account(Keypair.random().publicKey(), "7");
    const bumpXdr = buildFeeBumpXdr({
      feeSource,
      feePerOperation: 2000,
      innerTransactionXdr: buildInnerXdr(),
      networkPassphrase: PASSPHRASE,
    });
    expect(typeof bumpXdr).toBe("string");
  });

  it("throws a typed RpcError for an unparseable inner XDR", () => {
    const feeSource = new Account(Keypair.random().publicKey(), "1");
    expect(() =>
      buildFeeBumpXdr({
        feeSource,
        feePerOperation: "2000",
        innerTransactionXdr: "not-an-xdr",
        networkPassphrase: PASSPHRASE,
      }),
    ).toThrow(RpcError);
  });
});
