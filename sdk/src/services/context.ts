/**
 * The capability surface the services depend on. {@link OpaqueClient} implements
 * it; services depend on this interface (not the client class) so they stay
 * decoupled and unit-testable with a lightweight stub context.
 */
import type { ResolvedConfig } from "../config/index";
import type { OpaqueSigner } from "../signer/index";
import type { ContractInvoker } from "../rpc/client";
import type { TransferMemo } from "../crypto/memo";
import type { NoteStore, VaultStore, ScanStore } from "../storage/index";
import type { ArtifactResolver } from "../artifacts/index";
import type {
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

export interface ContractBindings {
  stealthRegistry: StealthRegistry;
  stealthAnnouncer: StealthAnnouncer;
  schemaRegistry: SchemaRegistry;
  attestationEngine: AttestationEngine;
  groth16Verifier: Groth16Verifier;
  reputationVerifier: ReputationVerifier;
  privacyPool: PrivacyPool;
  relayerRegistry: RelayerRegistry;
  /** Only set when `config.contracts.multisigAdmin` is configured — not yet deployed on any network. */
  multisigAdmin?: MultisigAdmin;
}

export interface OpaqueClientContext {
  readonly config: ResolvedConfig;
  readonly rpc: ContractInvoker;
  readonly contracts: ContractBindings;
  readonly notes: NoteStore;
  readonly vault: VaultStore;
  readonly scanStore: ScanStore;
  readonly signer?: OpaqueSigner;
  /** Circuit artifact resolver, when proof generation is enabled. */
  readonly artifacts?: ArtifactResolver;
  /** Returns the configured signer or throws if none is set. */
  requireSigner(): OpaqueSigner;
  /** Send a native XLM transfer (create-account or payment) via Horizon. */
  sendNativeTransfer(opts: {
    destination: string;
    amountStroops: bigint;
    signer: OpaqueSigner;
    /** Max fee per operation, in stroops. Defaults to BASE_FEE. */
    feePerOperation?: string | number;
    /** Validated memo to attach to the transfer. */
    memo?: TransferMemo;
  }): Promise<string>;
  /** Merge a source account into a destination, recovering the full reserve. */
  accountMerge(opts: {
    sourceSigner: OpaqueSigner;
    destination: string;
  }): Promise<string>;
  /** Fee-bump an already-signed, stuck transaction and resubmit it. */
  feeBumpTransaction(opts: {
    feeSigner: OpaqueSigner;
    innerTransactionXdr: string;
    feePerOperation: string | number;
  }): Promise<string>;
}
