/**
 * Destination memo risk + validation.
 *
 * Many Stellar custodians share one deposit address across users and rely on the
 * transaction memo to disambiguate. Sending to such an address without a memo can
 * lose funds. This module exposes a small allowlist of well-known custodial
 * addresses and validators that match the Stellar memo spec.
 */

export type MemoType = "none" | "text" | "id" | "hash" | "return";

const CUSTODIAL_ADDRESSES: Readonly<
  Record<string, { name: string; recommendedMemoType: MemoType }>
> = Object.freeze({
  GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM: {
    name: "Kraken",
    recommendedMemoType: "id",
  },
  GCGNWKCJ3KHRLPM3TMQN7IPVUMRPMYIPGKDPELDPRBMVUPLNZAJDK4VG: {
    name: "Binance",
    recommendedMemoType: "text",
  },
  GBJ65CCWNPGFNXIVRZMNQSGNXHJYM3O3HFK2CIHWXVKAFEWZNUQOH53I: {
    name: "Coinbase",
    recommendedMemoType: "text",
  },
  GDXBP3R6N62YR4MTEGEHDIJWQ6BIRYNG6UCV4XQEFKQGGYS7QUDXMJSX: {
    name: "KuCoin",
    recommendedMemoType: "text",
  },
});

export interface MemoRisk {
  isKnownCustodian: boolean;
  custodianName?: string;
  recommendedMemoType?: MemoType;
}

/** Look up the memo risk for a destination. Safe for any input. */
export function memoRiskFor(destination: string | undefined | null): MemoRisk {
  if (!destination) return { isKnownCustodian: false };
  const entry = CUSTODIAL_ADDRESSES[destination.trim()];
  if (!entry) return { isKnownCustodian: false };
  return {
    isKnownCustodian: true,
    custodianName: entry.name,
    recommendedMemoType: entry.recommendedMemoType,
  };
}

export interface MemoValidationResult {
  ok: boolean;
  error?: string;
}

/** Validate a memo value against the Stellar memo spec for the given type. */
export function validateMemo(
  memoType: MemoType,
  memo: string | undefined,
): MemoValidationResult {
  const value = (memo ?? "").trim();
  if (memoType === "none") {
    if (value.length > 0) {
      return { ok: false, error: "Memo must be empty when memo type is 'none'." };
    }
    return { ok: true };
  }
  if (value.length === 0) {
    return { ok: false, error: "Memo is required for this memo type." };
  }
  switch (memoType) {
    case "text": {
      const bytes = new TextEncoder().encode(value).byteLength;
      if (bytes > 28) {
        return { ok: false, error: "Text memo must be 28 UTF-8 bytes or fewer." };
      }
      return { ok: true };
    }
    case "id": {
      if (!/^\d+$/.test(value)) {
        return { ok: false, error: "ID memo must be a non-negative integer." };
      }
      try {
        const n = BigInt(value);
        if (n < 0n || n > 0xffffffffffffffffn) {
          return { ok: false, error: "ID memo must fit in an unsigned 64-bit integer." };
        }
      } catch {
        return { ok: false, error: "ID memo must be a non-negative integer." };
      }
      return { ok: true };
    }
    case "hash":
    case "return": {
      if (!/^[0-9a-fA-F]{64}$/.test(value)) {
        return { ok: false, error: "Hash/return memo must be 64 hexadecimal characters." };
      }
      return { ok: true };
    }
  }
}

/** Warning copy for the inline banner, or null when no warning is needed. */
export function memoWarningCopy(
  risk: MemoRisk,
  memo: string | undefined,
): string | null {
  if (!risk.isKnownCustodian) return null;
  if (memo && memo.trim().length > 0) return null;
  return `Destination looks like ${risk.custodianName ?? "an exchange or custodian"}. Sending without a memo may result in lost funds.`;
}

/** A memo to attach to an outgoing transfer. */
export interface TransferMemo {
  type: MemoType;
  value: string;
}

/**
 * Resolve the memo a transfer to `destination` must carry.
 *
 * - A provided memo is validated against the Stellar memo spec; an invalid
 *   memo throws.
 * - A known custodial destination *requires* a memo — sending without one can
 *   permanently lose the funds, so this throws instead of warning.
 * - Any other destination returns the memo as provided (or undefined).
 *
 * Throws plain `TypeError`s here; the services layer wraps them in the typed
 * {@link MemoError} so callers get a stable error code.
 */
export function resolveTransferMemo(
  destination: string,
  memo?: TransferMemo,
): TransferMemo | undefined {
  const risk = memoRiskFor(destination);

  if (memo) {
    const result = validateMemo(memo.type, memo.value);
    if (!result.ok) {
      throw new TypeError(`Invalid memo: ${result.error}`);
    }
    return memo;
  }

  if (risk.isKnownCustodian) {
    throw new TypeError(
      `Destination is ${risk.custodianName ?? "a known custodian"}; a ${risk.recommendedMemoType ?? "text"} memo is required.`,
    );
  }

  return undefined;
}
