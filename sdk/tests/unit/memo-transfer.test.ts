/**
 * Memo attachment on transfers and sweeps (issue #1173).
 *
 * `resolveTransferMemo` validates memos and *requires* one for known
 * custodial destinations; `PaymentsService` attaches the result to the
 * underlying transfer.
 */
import { describe, it, expect } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import {
  PaymentsService,
  MemoError,
  resolveTransferMemo,
  memoRiskFor,
  deriveKeysFromSignature,
  keysToStealthMetaAddress,
  stealthMetaAddressToHex,
  type OpaqueClientContext,
  type ContractInvoker,
  type InvokeOptions,
  type TransferMemo,
} from "../../src/index";

const KRAKEN = "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM";
const ORDINARY = Keypair.random().publicKey();

describe("resolveTransferMemo (#1173)", () => {
  it("requires a memo for known custodial destinations", () => {
    expect(() => resolveTransferMemo(KRAKEN)).toThrow(/Kraken.*memo is required/);
  });

  it("returns a provided custodial memo as-is", () => {
    const memo: TransferMemo = { type: "id", value: "12345" };
    expect(resolveTransferMemo(KRAKEN, memo)).toEqual(memo);
  });

  it("rejects an invalid memo regardless of destination", () => {
    expect(() =>
      resolveTransferMemo(ORDINARY, { type: "text", value: "x".repeat(29) }),
    ).toThrow(/Invalid memo/);
    expect(() =>
      resolveTransferMemo(ORDINARY, { type: "id", value: "-1" }),
    ).toThrow(/Invalid memo/);
  });

  it("passes ordinary destinations through without a memo", () => {
    expect(resolveTransferMemo(ORDINARY)).toBeUndefined();
  });

  it("memoRiskFor recognizes the custodial allowlist", () => {
    expect(memoRiskFor(KRAKEN).isKnownCustodian).toBe(true);
    expect(memoRiskFor(KRAKEN).custodianName).toBe("Kraken");
    expect(memoRiskFor(ORDINARY).isKnownCustodian).toBe(false);
  });
});

// ── PaymentsService wiring ──────────────────────────────────────────────────

function buildService(opts: {
  sendNativeTransfer?: OpaqueClientContext["sendNativeTransfer"];
  accountMerge?: OpaqueClientContext["accountMerge"];
}) {
  const invoker: ContractInvoker = {
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
  const signer = { publicKey: async () => Keypair.random().publicKey(), signTransaction: async (x: string) => x };
  const announced: unknown[] = [];
  const ctx = {
    config: {} as never,
    rpc: invoker,
    contracts: {
      stealthAnnouncer: {
        announce: async (o: { stealthAddress: Uint8Array; ephemeralPubKey: Uint8Array; metadata: Uint8Array }) => {
          announced.push(o);
          return "ANNOUNCE_HASH";
        },
      },
    },
    notes: {} as never,
    vault: {} as never,
    scanStore: {} as never,
    signer,
    requireSigner: () => signer,
    sendNativeTransfer:
      opts.sendNativeTransfer ??
      (async () => "PAY_HASH"),
    accountMerge: opts.accountMerge ?? (async () => "MERGE_HASH"),
    feeBumpTransaction: async () => "BUMP_HASH",
  } as unknown as OpaqueClientContext;
  return { service: new PaymentsService(ctx), announced };
}

/** A real recipient meta-address, derived via the SDK's own identity code. */
function recipientMetaHex(): string {
  const { viewingKey, spendingKey } = deriveKeysFromSignature("0x" + "ab".repeat(64));
  const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
  return stealthMetaAddressToHex(metaAddress);
}

describe("PaymentsService memo attachment (#1173)", () => {
  it("passes a validated memo through to sendNativeTransfer", async () => {
    const seen: Array<{ memo?: TransferMemo; destination: string }> = [];
    const { service } = buildService({
      sendNativeTransfer: async (o) => {
        seen.push({ memo: o.memo, destination: o.destination });
        return "PAY_HASH";
      },
    });

    await service.send({
      to: recipientMetaHex(),
      amountXlm: "1",
      memo: { type: "text", value: "invoice-1" },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].memo).toEqual({ type: "text", value: "invoice-1" });
  });

  it("send to a custodial destination without a memo throws MemoError before any transfer", async () => {
    let calls = 0;
    const { service } = buildService({
      sendNativeTransfer: async () => {
        calls += 1;
        return "PAY_HASH";
      },
    });

    await expect(
      service.send({ to: KRAKEN, amountXlm: "1" }),
    ).rejects.toThrow(MemoError);
    expect(calls).toBe(0);
  });

  it("sweep to a custodial destination without a memo throws MemoError", async () => {
    const { service } = buildService();
    await expect(
      service.sweep({
        stealthPrivKey: new Uint8Array(32),
        destination: KRAKEN,
        amountStroops: 100n,
      }),
    ).rejects.toThrow(MemoError);
  });

  it("sweep attaches a validated memo to the payment", async () => {
    const seen: Array<{ memo?: TransferMemo }> = [];
    const { service } = buildService({
      sendNativeTransfer: async (o) => {
        seen.push({ memo: o.memo });
        return "SWEEP_HASH";
      },
    });

    await service.sweep({
      stealthPrivKey: Uint8Array.from(Keypair.random().rawSecretKey()),
      destination: ORDINARY,
      amountStroops: 100n,
      memo: { type: "id", value: "77" },
    });

    expect(seen[0].memo).toEqual({ type: "id", value: "77" });
  });
});
