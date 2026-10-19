/**
 * The high-level entry point. One config + one signer wires the resolved network,
 * RPC client, contract bindings, storage, and the domain services
 * (`payments`, `pool`, `reputation`, `schemas`, `relayer`). Low-level escape
 * hatches (`rpc`, `contracts`, `soroban`) are exposed for advanced use.
 */
import {
  resolveConfig,
  type ContractVersions,
  type OpaqueConfig,
  type ResolvedConfig,
} from "../config/index";
import { RpcClient, type ContractInvoker } from "../rpc/client";
import type { OpaqueSigner } from "../signer/index";
import type { Logger } from "../logger/index";
import type { Telemetry } from "../telemetry/index";
import type { ArtifactResolver } from "../artifacts/index";
import {
  MemoryNoteStore,
  MemoryScanStore,
  MemoryVaultStore,
  type NoteStore,
  type ScanStore,
  type VaultStore,
} from "../storage/index";
import {
  AttestationEngine,
  Groth16Verifier,
  MultisigAdmin,
  PrivacyPool,
  RelayerRegistry,
  ReputationVerifier,
  SchemaRegistry,
  StealthAnnouncer,
  StealthRegistry,
} from "../contracts/index";
import { CompatibilityError, RpcError, SignerError } from "../errors/index";
import {
  PaymentsService,
  PoolService,
  RelayerService,
  ReputationService,
  SchemasService,
  type ContractBindings,
  type OpaqueClientContext,
} from "../services/index";

export interface OpaqueClientOptions extends OpaqueConfig {
  signer?: OpaqueSigner;
  storage?: { notes?: NoteStore; vault?: VaultStore; scan?: ScanStore };
  logger?: Logger;
  telemetry?: Telemetry;
  /** Circuit artifact resolver; enables proof generation when provided. */
  artifacts?: ArtifactResolver;
  /** Advanced / testing: inject a custom invoker instead of the built-in RpcClient. */
  invoker?: ContractInvoker;
}

export class OpaqueClient implements OpaqueClientContext {
  readonly config: ResolvedConfig;
  readonly rpc: ContractInvoker;
  readonly contracts: ContractBindings;
  readonly notes: NoteStore;
  readonly vault: VaultStore;
  readonly scanStore: ScanStore;
  readonly signer?: OpaqueSigner;
  readonly artifacts?: ArtifactResolver;

  readonly payments: PaymentsService;
  readonly pool: PoolService;
  readonly reputation: ReputationService;
  readonly schemas: SchemasService;
  readonly relayer: RelayerService;

  private readonly rpcClient?: RpcClient;

  /** Cached contract-version check promise (at most one round trip per session). */
  private versionCheckPromise?: Promise<void>;
  private disposed = false;

  constructor(opts: OpaqueClientOptions) {
    this.config = resolveConfig(opts);
    this.rpcClient = opts.invoker
      ? undefined
      : new RpcClient({
          config: this.config,
          logger: opts.logger,
          telemetry: opts.telemetry,
        });
    this.rpc = opts.invoker ?? (this.rpcClient as RpcClient);
    this.signer = opts.signer;
    this.artifacts = opts.artifacts;
    this.notes = opts.storage?.notes ?? new MemoryNoteStore();
    this.vault = opts.storage?.vault ?? new MemoryVaultStore();
    this.scanStore = opts.storage?.scan ?? new MemoryScanStore();

    const c = this.config.contracts;
    this.contracts = {
      stealthRegistry: new StealthRegistry(this.rpc, c.stealthRegistry),
      stealthAnnouncer: new StealthAnnouncer(this.rpc, c.stealthAnnouncer),
      schemaRegistry: new SchemaRegistry(this.rpc, c.schemaRegistry),
      attestationEngine: new AttestationEngine(this.rpc, c.attestationEngineV2),
      groth16Verifier: new Groth16Verifier(this.rpc, c.groth16Verifier),
      reputationVerifier: new ReputationVerifier(this.rpc, c.reputationVerifier),
      privacyPool: new PrivacyPool(this.rpc, c.privacyPool),
      relayerRegistry: new RelayerRegistry(this.rpc, c.relayerRegistry),
      multisigAdmin: c.multisigAdmin ? new MultisigAdmin(this.rpc, c.multisigAdmin) : undefined,
    };

    this.schemas = new SchemasService(this);
    this.payments = new PaymentsService(this);
    this.pool = new PoolService(this);
    this.relayer = new RelayerService(this);
    this.reputation = new ReputationService(this, this.schemas);

    // Fire-and-forget version check — will reject on first use if mismatched.
    if (!opts.skipVersionCheck && this.config.contractVersions && this.rpcClient) {
      this.versionCheckPromise = this.checkContractVersions();
    }
  }

  /**
   * Read each deployed contract's `version()` and compare against the expected
   * versions baked in the deployment config. Throws {@link CompatibilityError}
   * on any mismatch so the caller gets actionable guidance before any transaction.
   * Cached: at most one RPC round trip per session.
   */
  private async checkContractVersions(): Promise<void> {
    const expected = this.config.contractVersions!;
    const source = "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU";
    const mismatches: Array<{ contract: string; contractId: string; expected: number; deployed: number }> = [];

    const checks: Array<{ contract: keyof ContractVersions; contractId: string; fn: () => Promise<number> }> = [
      { contract: "stealthRegistry", contractId: this.config.contracts.stealthRegistry, fn: () => this.contracts.stealthRegistry.version(source) },
      { contract: "stealthAnnouncer", contractId: this.config.contracts.stealthAnnouncer, fn: () => this.contracts.stealthAnnouncer.version(source) },
      { contract: "schemaRegistry", contractId: this.config.contracts.schemaRegistry, fn: () => this.contracts.schemaRegistry.version(source) },
      { contract: "attestationEngineV2", contractId: this.config.contracts.attestationEngineV2, fn: () => this.contracts.attestationEngine.version(source) },
      { contract: "groth16Verifier", contractId: this.config.contracts.groth16Verifier, fn: () => this.contracts.groth16Verifier.version(source) },
      { contract: "reputationVerifier", contractId: this.config.contracts.reputationVerifier, fn: () => this.contracts.reputationVerifier.version(source) },
      { contract: "privacyPool", contractId: this.config.contracts.privacyPool, fn: () => this.contracts.privacyPool.version(source) },
      { contract: "relayerRegistry", contractId: this.config.contracts.relayerRegistry, fn: () => this.contracts.relayerRegistry.version(source) },
    ];

    for (const check of checks) {
      const expectedVersion = expected[check.contract];
      if (expectedVersion === undefined) continue;
      try {
        const deployed = await check.fn();
        if (deployed !== expectedVersion) {
          mismatches.push({ contract: check.contract, contractId: check.contractId, expected: expectedVersion, deployed });
        }
      } catch {
        // skip — failed to query; let the user discover deeper issues naturally
      }
    }

    if (mismatches.length > 0) {
      throw new CompatibilityError(mismatches);
    }
  }

  /** The built-in Soroban/Horizon client, or undefined when a custom invoker was injected. */
  get soroban(): RpcClient | undefined {
    return this.rpcClient;
  }

  /** Returns the configured signer or throws if none was set. */
  requireSigner(): OpaqueSigner {
    if (!this.signer) {
      throw new SignerError(
        "This operation requires a signer. Construct OpaqueClient with { signer }.",
      );
    }
    return this.signer;
  }

  /** Send a native XLM transfer through the built-in RpcClient. */
  sendNativeTransfer(opts: {
    destination: string;
    amountStroops: bigint;
    signer: OpaqueSigner;
    /** Max fee per operation, in stroops. Defaults to BASE_FEE. */
    feePerOperation?: string | number;
    /** Validated memo to attach to the transfer. */
    memo?: import("../crypto/memo").TransferMemo;
  }): Promise<string> {
    if (!this.rpcClient) {
      throw new RpcError(
        "Native transfers require the built-in RpcClient (unavailable with a custom invoker).",
      );
    }
    return this.rpcClient.sendNativeTransfer(opts);
  }

  /** Merge an account into a destination, recovering the full base reserve. */
  accountMerge(opts: {
    sourceSigner: OpaqueSigner;
    destination: string;
  }): Promise<string> {
    if (!this.rpcClient) {
      throw new RpcError(
        "Account merges require the built-in RpcClient (unavailable with a custom invoker).",
      );
    }
    return this.rpcClient.accountMerge(opts);
  }

  /**
   * Fee-bump an already-signed, stuck transaction through the built-in
   * RpcClient (`feeSigner` pays the bumped fee).
   */
  feeBumpTransaction(opts: {
    feeSigner: OpaqueSigner;
    innerTransactionXdr: string;
    feePerOperation: string | number;
  }): Promise<string> {
    if (!this.rpcClient) {
      throw new RpcError(
        "Fee bumps require the built-in RpcClient (unavailable with a custom invoker).",
      );
    }
    return this.rpcClient.feeBumpTransaction(opts);
  }

  /**
   * Wait for the contract-version handshake to complete (kicked off at
   * construction). Returns immediately when the handshake is not configured
   * (custom invoker, stale versions, or `skipVersionCheck`). Throws
   * {@link CompatibilityError} on version mismatch, providing both the
   * expected and deployed versions in the error detail.
   *
   * Callers building on an untrusted network should await this before the
   * first transaction to fail fast if the deployed contracts are incompatible.
   *
   * @example
   * ```ts
   * const client = new OpaqueClient({ network: "testnet", signer });
   * await client.waitForReady();
   * ```
   */
  async waitForReady(): Promise<void> {
    return this.versionCheckPromise ?? Promise.resolve();
  }

  /** Whether {@link dispose} has been called on this client. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Release resources held for proving: terminates the worker threads `snarkjs`
   * (via `ffjavascript`) keeps alive on the cached BN128 curve, so a Node
   * script can end naturally without `process.exit`. Idempotent; safe to call
   * when no proof was ever generated. Proving after disposal re-spawns workers.
   *
   * @example
   * ```ts
   * try {
   *   await opaque.reputation.verifyOnChain(proof);
   * } finally {
   *   await opaque.dispose();
   * }
   * ```
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.versionCheckPromise?.catch(() => undefined);
    await terminateSnarkjsCurves();
  }
}

interface TerminableCurve {
  terminate?: () => unknown;
}

/**
 * ffjavascript caches each curve on `globalThis.curve_<name>` and keeps its
 * worker threads alive until `terminate()` is called.
 */
async function terminateSnarkjsCurves(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  for (const key of ["curve_bn128", "curve_bls12381"]) {
    const curve = g[key] as TerminableCurve | undefined;
    if (curve && typeof curve.terminate === "function") {
      await curve.terminate();
      delete g[key];
    }
  }
}
