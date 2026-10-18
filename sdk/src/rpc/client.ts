/**
 * Soroban RPC client. Holds resolved config, a signer, and observability hooks,
 * and exposes contract `invoke` (write) and `read` (read-only simulate) with
 * multi-endpoint read fallback, bounded polling, typed errors, and decoded
 * diagnostics. No ambient globals: everything comes from {@link ResolvedConfig}.
 */
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Memo,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { ResolvedConfig } from "../config/index";
import type { OpaqueSigner } from "../signer/index";
import { formatStroopsToXlm } from "../crypto/amount";
import type { TransferMemo } from "../crypto/memo";
import { silentLogger, type Logger } from "../logger/index";
import { noopTelemetry, type Telemetry } from "../telemetry/index";
import {
  ContractError,
  MergeIncompatibleError,
  RpcError,
  SimulationError,
} from "../errors/index";
import { contractErrorName } from "../errors/index";
import { decodeDiagnostics, extractContractErrorCode } from "./diagnostics";

const READ_TIMEOUT_MS = 12_000;
const READ_RETRIES_PER_PROVIDER = 2;
const TX_POLL_TIMEOUT_MS = 60_000;
const TX_POLL_INTERVAL_MS = 1_000;

/** Minimum starting balance (stroops) to create a fresh Stellar account (1 XLM). */
export const NEW_ACCOUNT_MIN_RESERVE_STROOPS = 10_000_000n;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map a validated {@link TransferMemo} onto its stellar-sdk `Memo`. */
function toStellarSdkMemo(memo?: TransferMemo): Memo | undefined {
  if (!memo) return undefined;
  switch (memo.type) {
    case "none":
      return undefined;
    case "text":
      return Memo.text(memo.value);
    case "id":
      return Memo.id(memo.value);
    case "hash":
      return Memo.hash(memo.value);
    case "return":
      return Memo.return(memo.value);
  }
}

/**
 * Build a fee-bump envelope around an already-signed inner transaction.
 * Pure: no network access — the caller loads the fee source account (sequence
 * number) and submits the returned XDR.
 *
 * @param feeSource        Fee-bump source account (with its current sequence).
 * @param feePerOperation  Max fee per operation, in stroops (string or number).
 * @param innerTransactionXdr  The signed inner transaction, as base64 XDR.
 * @param networkPassphrase   Passphrase the inner transaction was built for.
 */
export function buildFeeBumpXdr(opts: {
  feeSource: Account;
  feePerOperation: string | number;
  innerTransactionXdr: string;
  networkPassphrase: string;
}): string {
  let inner;
  try {
    inner = TransactionBuilder.fromXDR(opts.innerTransactionXdr, opts.networkPassphrase);
  } catch (err) {
    throw new RpcError("Inner transaction XDR could not be parsed.", { cause: err });
  }
  try {
    return TransactionBuilder.buildFeeBumpTransaction(
      opts.feeSource,
      String(opts.feePerOperation),
      inner,
      opts.networkPassphrase,
    ).toXDR();
  } catch (err) {
    throw new RpcError("Fee-bump transaction could not be built.", { cause: err });
  }
}

/**
 * Pull CPU/read/write resource counts out of a simulation's Soroban transaction
 * data. Defensive: the generated XDR accessor names have shifted across
 * protocol versions, so this never throws — it reports zeros rather than fail a
 * dry run over an introspection detail.
 */
function extractResourceUsage(transactionData: {
  build(): unknown;
}): SimulatedResourceUsage {
  try {
    const resources = (
      transactionData.build() as {
        resources(): {
          instructions(): number;
          readBytes?(): number;
          diskReadBytes?(): number;
          writeBytes(): number;
        };
      }
    ).resources();
    return {
      cpuInstructions: Number(resources.instructions()),
      readBytes: Number(resources.diskReadBytes?.() ?? resources.readBytes?.() ?? 0),
      writeBytes: Number(resources.writeBytes()),
    };
  } catch {
    return { cpuInstructions: 0, readBytes: 0, writeBytes: 0 };
  }
}

/** Pull an HTTP status off the many shapes stellar-sdk / fetch errors take. */
function extractStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const candidate of [e.status, e.statusCode, e.response?.status]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function isRetryableReadError(err: unknown): boolean {
  const status =
    typeof err === "object" && err !== null && "response" in err
      ? (err as { response?: { status?: number } }).response?.status
      : undefined;
  if (status && [408, 429, 500, 502, 503, 504].includes(status)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|rate.?limit|too many requests|network|fetch/i.test(message);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RpcError(`${label} timed out after ${READ_TIMEOUT_MS}ms`)),
      READ_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RpcClientOptions {
  config: ResolvedConfig;
  logger?: Logger;
  telemetry?: Telemetry;
}

export interface InvokeOptions {
  source: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  signer: OpaqueSigner;
  /** Skip pre-flight simulation (default false). */
  skipSimulation?: boolean;
  /** Contract package name for error naming (e.g. "reputation-verifier"). */
  contractPackage?: string;
}

export interface ReadOptions {
  source: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export interface SimulateInvokeOptions {
  /** Account the (unsubmitted) transaction is built for. */
  source: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export interface SimulatedResourceUsage {
  /** CPU instructions the transaction would consume. */
  cpuInstructions: number;
  /** Ledger-entry bytes read. */
  readBytes: number;
  /** Ledger-entry bytes written. */
  writeBytes: number;
}

export interface SimulationReport {
  /** Estimated resource fee (stroops) simulation says the transaction would need. */
  minResourceFeeStroops: bigint;
  /** Best-effort resource usage breakdown; zeroed out if unavailable. */
  resources: SimulatedResourceUsage;
  /** Native-decoded return value of the simulated call, if any. */
  returnValue: unknown;
}

/**
 * The subset of {@link RpcClient} the contract bindings depend on. Bindings are
 * written against this interface so they can be unit-tested with a stub invoker
 * (no network) and dogfooded with the real client in production.
 */
export interface ContractInvoker {
  invoke(opts: InvokeOptions): Promise<string>;
  readNative<T = unknown>(opts: ReadOptions): Promise<T>;
  simulateRead(opts: ReadOptions): Promise<xdr.ScVal | undefined>;
  getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
  getLatestLedger(): Promise<number>;
  /**
   * Build and simulate a write call without signing or submitting it (a dry
   * run). Optional: implementations that only support reads/writes may omit it.
   */
  simulateInvoke?(opts: SimulateInvokeOptions): Promise<SimulationReport>;
}

export class RpcClient {
  readonly config: ResolvedConfig;
  private readonly logger: Logger;
  private readonly telemetry: Telemetry;
  private readonly servers: rpc.Server[];

  constructor(opts: RpcClientOptions) {
    this.config = opts.config;
    this.logger = opts.logger ?? silentLogger;
    this.telemetry = opts.telemetry ?? noopTelemetry;
    this.servers = opts.config.rpcUrls.map(
      (url) => new rpc.Server(url, { allowHttp: url.startsWith("http://") }),
    );
    if (this.servers.length === 0) {
      throw new RpcError("RpcClient requires at least one RPC URL");
    }
  }

  /** Primary Soroban RPC server. */
  get server(): rpc.Server {
    return this.servers[0];
  }

  /** Horizon server (first configured Horizon URL). */
  horizon(): Horizon.Server {
    return new Horizon.Server(this.config.horizonUrls[0]);
  }

  /** Whether an account exists on-ledger. */
  async accountExists(publicKey: string): Promise<boolean> {
    try {
      await this.horizon().loadAccount(publicKey);
      return true;
    } catch (err) {
      // Only a definitive 404 means "no such account". A 429, 5xx, timeout, or
      // dropped connection is an *unknown*, and reporting `false` for those makes
      // `sendNativeTransfer` build a `createAccount` against an account that
      // already exists — burning the fee before failing with `ALREADY_EXIST`.
      const status = extractStatus(err);
      if (status !== 404) {
        throw new RpcError(`Account lookup failed for ${publicKey}`, {
          ...(status === null ? {} : { httpStatus: status }),
          cause: err,
        });
      }
      return false;
    }
  }

  /**
   * Send a native XLM transfer. Uses `createAccount` when the destination does
   * not exist yet (stealth accounts), otherwise a `payment`. Signs via the
   * provided signer and submits through Horizon.
   *
   * `feePerOperation` caps the fee this transaction may pay, in stroops
   * (stellar-sdk multiplies by the operation count). Defaults to `BASE_FEE`
   * (100). Raise it during congestion to get included sooner.
   *
   * `memo` is attached to the payment/createAccount operation (validated by
   * the caller or via `payments.send` / `payments.sweep`).
   */
  async sendNativeTransfer(opts: {
    destination: string;
    amountStroops: bigint;
    signer: OpaqueSigner;
    /** Max fee per operation, in stroops. Defaults to BASE_FEE. */
    feePerOperation?: string | number;
    /** Memo to attach (validate with crypto/memo first). */
    memo?: TransferMemo;
  }): Promise<string> {
    const source = await opts.signer.publicKey();
    const horizon = this.horizon();
    const sourceAccount = await horizon.loadAccount(source);
    const destExists = await this.accountExists(opts.destination);
    const amount = formatStroopsToXlm(opts.amountStroops);

    if (!destExists && opts.amountStroops < NEW_ACCOUNT_MIN_RESERVE_STROOPS) {
      throw new RpcError(
        "Destination account does not exist; create-account requires at least 1 XLM.",
      );
    }

    const op = destExists
      ? Operation.payment({ destination: opts.destination, asset: Asset.native(), amount })
      : Operation.createAccount({ destination: opts.destination, startingBalance: amount });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: opts.feePerOperation != null ? String(opts.feePerOperation) : BASE_FEE,
      networkPassphrase: this.config.passphrase,
    })
      .addOperation(op)
      .addMemo(toStellarSdkMemo(opts.memo) ?? Memo.none())
      .setTimeout(180)
      .build();

    const signedXdr = await opts.signer.signTransaction(tx.toXDR(), {
      networkPassphrase: this.config.passphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, this.config.passphrase);
    const result = await horizon.submitTransaction(
      signed as Parameters<Horizon.Server["submitTransaction"]>[0],
    );
    return result.hash;
  }

  /**
   * Fee-bump a stuck, already-signed transaction: wrap it in a new envelope
   * that pays a higher fee, sign with the fee source, and resubmit. The inner
   * transaction keeps its original source and operations; Horizon replaces the
   * stalled entry when the bump lands.
   */
  async feeBumpTransaction(opts: {
    /** Account footing the bumped fee (must be able to sign). */
    feeSigner: OpaqueSigner;
    /** Signed inner transaction to bump, as base64 XDR. */
    innerTransactionXdr: string;
    /** New max fee per operation, in stroops; must exceed the inner fee. */
    feePerOperation: string | number;
  }): Promise<string> {
    const feeSource = await opts.feeSigner.publicKey();
    const horizon = this.horizon();
    const account = await horizon.loadAccount(feeSource);
    const bumpXdr = buildFeeBumpXdr({
      feeSource: account,
      feePerOperation: opts.feePerOperation,
      innerTransactionXdr: opts.innerTransactionXdr,
      networkPassphrase: this.config.passphrase,
    });
    const signedXdr = await opts.feeSigner.signTransaction(bumpXdr, {
      networkPassphrase: this.config.passphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, this.config.passphrase);
    const result = await horizon.submitTransaction(
      signed as Parameters<Horizon.Server["submitTransaction"]>[0],
    );
    return result.hash;
  }

  /**
   * Merge a Stellar account into `destination`, recovering the full balance —
   * including the base reserve a payment-based sweep leaves behind. Refuses
   * with {@link MergeIncompatibleError} when the account holds state a merge
   * cannot delete (trustlines, offers); fall back to a partial
   * {@link sendNativeTransfer} sweep in that case.
   */
  async accountMerge(opts: {
    sourceSigner: OpaqueSigner;
    destination: string;
  }): Promise<string> {
    const source = await opts.sourceSigner.publicKey();
    const horizon = this.horizon();
    const account = await horizon.loadAccount(source);

    // `accountMerge` deletes the account; anything other than a pure native
    // balance (a trustline, an offer, liabilities) makes the operation fail
    // on-chain after the fee is burned. Detect the common case up-front.
    const incompatible = (account.balances ?? [])
      .filter((b: { asset_type: string }) => b.asset_type !== "native")
      .map((b: { asset_type: string; asset_code?: string; asset_issuer?: string }) =>
        b.asset_code ? `${b.asset_code}:${b.asset_issuer ?? "?"}` : b.asset_type,
      );
    if (incompatible.length > 0) {
      throw new MergeIncompatibleError(source, incompatible);
    }

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.passphrase,
    })
      .addOperation(Operation.accountMerge({ destination: opts.destination }))
      .setTimeout(180)
      .build();

    const signedXdr = await opts.sourceSigner.signTransaction(tx.toXDR(), {
      networkPassphrase: this.config.passphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, this.config.passphrase);
    const result = await horizon.submitTransaction(
      signed as Parameters<Horizon.Server["submitTransaction"]>[0],
    );
    return result.hash;
  }

  /** Run a read across providers with retry + timeout; throws RpcError on exhaustion. */
  private async read<T>(fn: (server: rpc.Server) => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;
    for (const server of this.servers) {
      for (let attempt = 0; attempt < READ_RETRIES_PER_PROVIDER; attempt += 1) {
        try {
          return await withTimeout(fn(server), label);
        } catch (err) {
          lastError = err;
          if (!isRetryableReadError(err)) throw err;
          if (attempt + 1 < READ_RETRIES_PER_PROVIDER) await sleep(350 * (attempt + 1));
        }
      }
    }
    throw lastError instanceof Error
      ? new RpcError(`${label} failed: ${lastError.message}`, { cause: lastError })
      : new RpcError(`${label} failed`);
  }

  private async poll(txHash: string): Promise<rpc.Api.GetTransactionResponse> {
    const start = Date.now();
    while (Date.now() - start < TX_POLL_TIMEOUT_MS) {
      const res = await this.server.getTransaction(txHash);
      if (res.status !== "NOT_FOUND") return res;
      await sleep(TX_POLL_INTERVAL_MS);
    }
    throw new RpcError(`Transaction polling timed out for ${txHash}`);
  }

  /** Fetch contract events (paged) with read fallback. */
  async getEvents(
    request: rpc.Server.GetEventsRequest,
  ): Promise<rpc.Api.GetEventsResponse> {
    return this.read((s) => s.getEvents(request), "getEvents");
  }

  /** Latest ledger sequence. */
  async getLatestLedger(): Promise<number> {
    const res = await this.read((s) => s.getLatestLedger(), "getLatestLedger");
    return res.sequence;
  }

  /** Read-only contract call via simulation. Returns the decoded return ScVal. */
  async simulateRead(opts: ReadOptions): Promise<xdr.ScVal | undefined> {
    const account = await this.read(
      (s) => s.getAccount(opts.source),
      "getAccount",
    );
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.passphrase,
    })
      .addOperation(new Contract(opts.contractId).call(opts.method, ...opts.args))
      .setTimeout(60)
      .build();

    const sim = await this.read(
      (s) => s.simulateTransaction(tx),
      `simulate ${opts.method}`,
    );
    if (rpc.Api.isSimulationError(sim)) {
      throw new SimulationError(`Simulation failed for ${opts.method}`, {
        diagnostics: sim.error,
      });
    }
    return sim.result?.retval;
  }

  /** Read-only contract call returning the native-decoded value. */
  async readNative<T = unknown>(opts: ReadOptions): Promise<T> {
    const retval = await this.simulateRead(opts);
    return (retval ? scValToNative(retval) : undefined) as T;
  }

  /**
   * Build and simulate a write call without signing or submitting it. Used for
   * dry runs: reports the resource fee and usage a real submission would incur,
   * with no on-chain side effects (no nullifier/state is touched).
   */
  async simulateInvoke(opts: SimulateInvokeOptions): Promise<SimulationReport> {
    const account = await this.read((s) => s.getAccount(opts.source), "getAccount");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.passphrase,
    })
      .addOperation(new Contract(opts.contractId).call(opts.method, ...opts.args))
      .setTimeout(60)
      .build();

    const sim = await this.read(
      (s) => s.simulateTransaction(tx),
      `simulate ${opts.method}`,
    );
    if (rpc.Api.isSimulationError(sim)) {
      throw new SimulationError(`Simulation failed for ${opts.method}`, {
        diagnostics: sim.error,
      });
    }
    return {
      minResourceFeeStroops: BigInt(sim.minResourceFee),
      resources: extractResourceUsage(sim.transactionData),
      returnValue: sim.result?.retval ? scValToNative(sim.result.retval) : undefined,
    };
  }

  /** Invoke a contract method as a signed transaction. Returns the tx hash. */
  async invoke(opts: InvokeOptions): Promise<string> {
    const start = Date.now();
    try {
      const account = await this.read(
        (s) => s.getAccount(opts.source),
        "getAccount",
      );
      const raw = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.passphrase,
      })
        .addOperation(new Contract(opts.contractId).call(opts.method, ...opts.args))
        .setTimeout(180)
        .build();

      let prepared = raw;
      if (!opts.skipSimulation) {
        const sim = await this.server.simulateTransaction(raw);
        if (rpc.Api.isSimulationError(sim)) {
          throw new SimulationError(`Simulation failed for ${opts.method}`, {
            diagnostics: sim.error,
          });
        }
        prepared = rpc.assembleTransaction(raw, sim).build();
      } else {
        prepared = await this.server.prepareTransaction(raw);
      }

      const signedXdr = await opts.signer.signTransaction(prepared.toXDR(), {
        networkPassphrase: this.config.passphrase,
      });
      const signed = TransactionBuilder.fromXDR(signedXdr, this.config.passphrase);
      const send = await this.server.sendTransaction(
        signed as Parameters<rpc.Server["sendTransaction"]>[0],
      );
      if (send.status === "ERROR") {
        throw new RpcError(`sendTransaction rejected: ${JSON.stringify(send.errorResult)}`);
      }

      const result = await this.poll(send.hash);
      if (result.status !== "SUCCESS") {
        throw this.toContractError(opts, result);
      }

      this.telemetry.onContractCall?.({
        contractId: opts.contractId,
        method: opts.method,
        success: true,
        durationMs: Date.now() - start,
      });
      return send.hash;
    } catch (err) {
      this.telemetry.onContractCall?.({
        contractId: opts.contractId,
        method: opts.method,
        success: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private toContractError(
    opts: InvokeOptions,
    result: rpc.Api.GetTransactionResponse,
  ): Error {
    const events =
      (result as unknown as { diagnosticEventsXdr?: unknown[] }).diagnosticEventsXdr ?? [];
    const diagnostics = events.length ? decodeDiagnostics(events) : "";
    const code = events.length ? extractContractErrorCode(events) : null;
    if (code !== null) {
      return new ContractError({
        contract: opts.contractPackage ?? opts.contractId,
        contractCode: code,
        errorName: opts.contractPackage
          ? contractErrorName(opts.contractPackage, code)
          : undefined,
      });
    }
    this.logger.error(`tx ${result.status}`, diagnostics);
    return new RpcError(
      `Transaction ${result.status}` + (diagnostics ? `: ${diagnostics}` : ""),
    );
  }
}
