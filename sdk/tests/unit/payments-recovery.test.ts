/**
 * Unannounced-payment recovery (issue #1174) and merge-based sweeps
 * (issue #1175).
 */
import { describe, it, expect } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import {
  PaymentsService,
  UnannouncedPaymentError,
  deriveKeysFromSignature,
  keysToStealthMetaAddress,
  stealthMetaAddressToHex,
  type OpaqueClientContext,
  type ContractInvoker,
  type InvokeOptions,
} from "../../src/index";

function recipientMetaHex(seed: string): string {
  const { viewingKey, spendingKey } = deriveKeysFromSignature("0x" + seed.repeat(64));
  const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
  return stealthMetaAddressToHex(metaAddress);
}

function stubInvoker(): ContractInvoker {
  return {
    async invoke(_o: InvokeOptions) {
      return "TXHASH";
    },
    async readNative() {
      return 42;
    },
    async simulateRead(): Promise<xdr.ScVal | undefined> {
      return undefined;
    },
    async getEvents() {
      return { events: [], latestLedger: 0, cursor: "" } as unknown as rpc.Api.GetEventsResponse;
    },
    async getLatestLedger() {
      return 0;
    },
  };
}

function buildService(opts: {
  sendNativeTransfer?: OpaqueClientContext["sendNativeTransfer"];
  accountMerge?: OpaqueClientContext["accountMerge"];
  announce?: () => Promise<string>;
}) {
  const invoker = stubInvoker();
  const signer = {
    publicKey: async () => Keypair.random().publicKey(),
    signTransaction: async (x: string) => x,
  };
  const announceCalls: unknown[] = [];
  const ctx = {
    config: {} as never,
    rpc: invoker,
    contracts: {
      stealthAnnouncer: {
        announce: async (o: Record<string, unknown>) => {
          announceCalls.push(o);
          return opts.announce ? opts.announce() : "ANNOUNCE_HASH";
        },
      },
    },
    notes: {} as never,
    vault: {} as never,
    scanStore: {} as never,
    signer,
    requireSigner: () => signer,
    sendNativeTransfer: opts.sendNativeTransfer ?? (async () => "PAY_HASH"),
    accountMerge: opts.accountMerge ?? (async () => "MERGE_HASH"),
    feeBumpTransaction: async () => "BUMP_HASH",
  } as unknown as OpaqueClientContext;
  return { service: new PaymentsService(ctx), announceCalls, signer };
}

describe("UnannouncedPaymentError recovery (#1174)", () => {
  it("a failed announcement surfaces a typed error carrying the retry parameters", async () => {
    const { service } = buildService({
      announce: async () => {
        throw new Error("announcement RPC down");
      },
    });

    let caught: UnannouncedPaymentError | undefined;
    try {
      await service.send({ to: recipientMetaHex("cd"), amountXlm: "2" });
    } catch (err) {
      caught = err as UnannouncedPaymentError;
    }

    expect(caught).toBeInstanceOf(UnannouncedPaymentError);
    expect(caught!.code).toBe("UNANNOUNCED_PAYMENT");
    expect(caught!.paymentTxHash).toBe("PAY_HASH");
    expect(caught!.amountStroops).toBe(20000000n);
    expect(caught!.ephemeralPubKey).toBeInstanceOf(Uint8Array);
    expect(caught!.metadata).toBeInstanceOf(Uint8Array);
    expect(caught!.stealthAddressHex).toMatch(/^0x[0-9a-f]+$/);
    expect(caught!.message).toMatch(/announcePaidTransfer/);
  });

  it("toAnnounceParams round-trips the exact announcement parameters", async () => {
    const { service } = buildService({
      announce: async () => {
        throw new Error("boom");
      },
    });

    let caught: UnannouncedPaymentError | undefined;
    try {
      await service.send({ to: recipientMetaHex("ef"), amountXlm: "1" });
    } catch (err) {
      caught = err as UnannouncedPaymentError;
    }

    const params = caught!.toAnnounceParams();
    expect(params.stealthAddress).toBeInstanceOf(Uint8Array);
    expect(params.ephemeralPubKey).toEqual(caught!.ephemeralPubKey);
    expect(params.metadata).toEqual(caught!.metadata);
    // Hex encoding of the address bytes matches the carried field.
    expect(
      Array.from(params.stealthAddress)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    ).toBe(caught!.stealthAddressHex.replace(/^0x/, ""));
  });

  it("announcePaidTransfer re-announces the paid transfer and returns the hash", async () => {
    const { service, announceCalls } = buildService();

    let caught: UnannouncedPaymentError | undefined;
    const failing = buildService({
      announce: async () => {
        throw new Error("first attempt failed");
      },
    });
    try {
      await failing.service.send({ to: recipientMetaHex("12"), amountXlm: "1" });
    } catch (err) {
      caught = err as UnannouncedPaymentError;
    }

    const hash = await service.announcePaidTransfer(caught!.toAnnounceParams());
    expect(hash).toBe("ANNOUNCE_HASH");
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].stealthAddress).toBeInstanceOf(Uint8Array);
  });

  it("a successful send returns both transaction hashes", async () => {
    const { service } = buildService();
    const result = await service.send({ to: recipientMetaHex("34"), amountXlm: "1" });
    expect(result.paymentTxHash).toBe("PAY_HASH");
    expect(result.announceTxHash).toBe("ANNOUNCE_HASH");
  });
});

describe("merge-based sweeps (#1175)", () => {
  it("sweepWithMerge merges the stealth account into the destination", async () => {
    const seen: Array<{ destination: string; sourcePub: string }> = [];
    const stealth = Keypair.random();
    const { service } = buildService({
      accountMerge: async (o) => {
        seen.push({
          destination: o.destination,
          sourcePub: await o.sourceSigner.publicKey(),
        });
        return "MERGE_HASH";
      },
    });

    const hash = await service.sweepWithMerge({
      stealthPrivKey: Uint8Array.from(stealth.rawSecretKey()),
      destination: "GDEST",
    });

    expect(hash).toBe("MERGE_HASH");
    expect(seen).toHaveLength(1);
    expect(seen[0].destination).toBe("GDEST");
    // The one-time stealth account — not the connected wallet — signs the merge.
    expect(seen[0].sourcePub).toBe(stealth.publicKey());
  });

  it("sweepWithMerge surfaces merge-incompatible states as errors", async () => {
    const { service } = buildService({
      accountMerge: async () => {
        const { MergeIncompatibleError } = await import("../../src/index");
        throw new MergeIncompatibleError("GSTEALTH", ["USDC:GISSUER"]);
      },
    });

    await expect(
      service.sweepWithMerge({
        stealthPrivKey: Uint8Array.from(Keypair.random().rawSecretKey()),
        destination: "GDEST",
      }),
    ).rejects.toThrow(/cannot be merged/);
  });
});
