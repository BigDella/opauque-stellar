/**
 * On-chain ZK reputation. Submit a V2 Groth16 proof to the reputation-verifier
 * (root validity + nullifier-replay enforced on-chain), read the latest published
 * root, and attest (delegated to the schema service). Proof generation requires
 * an artifact resolver (snarkjs + circuit artifacts); use {@link prove} or
 * {@link proveAndVerify} when configured, or bring a precomputed proof to
 * {@link verifyOnChain}.
 */
import { NotWiredError } from "../errors/index";
import {
  PublisherClient,
  type PublisherClientOptions,
  type PublisherInclusionPath,
  type PublisherSubmitResult,
} from "./publisher";
import type { VerifyReputationInputs } from "../contracts/verifier";
import {
  computeReputationLeaf,
  proveReputationV2,
  type ReputationProof,
  type ReputationProveInput,
} from "../prove/reputation";
import type { OpaqueClientContext } from "./context";
import type { SchemasService } from "./schemas";

export class ReputationService {
  private publisherClient?: PublisherClient;

  constructor(
    private readonly ctx: OpaqueClientContext,
    private readonly schemas: SchemasService,
  ) {}

  /**
   * Client for the reputation publisher at `config.reputationPublisherUrl`.
   * Throws {@link NotWiredError} when no publisher URL is configured. Passing
   * `opts` builds a fresh client (e.g. with a submit token).
   */
  publisher(opts?: Omit<PublisherClientOptions, "baseUrl">): PublisherClient {
    const baseUrl = this.ctx.config.reputationPublisherUrl;
    if (!baseUrl) {
      throw new NotWiredError(
        "Reputation publisher",
        "Construct OpaqueClient with { reputationPublisherUrl } to use the publisher.",
      );
    }
    if (opts) return new PublisherClient({ ...opts, baseUrl });
    this.publisherClient ??= new PublisherClient({ baseUrl });
    return this.publisherClient;
  }

  /** Compute the holder's Merkle leaf (0x-hex) for an attestation. */
  leafFor(input: Pick<ReputationProveInput, "attestationId" | "stealthPrivKey">): Promise<string> {
    return computeReputationLeaf(input);
  }

  /** Queue the holder's leaf on the publisher for the next published root. */
  async submitLeaf(
    input: Pick<ReputationProveInput, "attestationId" | "stealthPrivKey"> & {
      id?: string;
      submitToken?: string;
    },
  ): Promise<PublisherSubmitResult> {
    const leaf = await computeReputationLeaf(input);
    const client = this.publisher(input.submitToken ? { submitToken: input.submitToken } : undefined);
    return client.submitLeaf({ leaf, id: input.id ?? leaf });
  }

  /**
   * Fetch the holder's inclusion path + root from the publisher. Throws
   * {@link RootUnavailableError} until a published root covers the leaf.
   */
  async getInclusionPath(
    input: Pick<ReputationProveInput, "attestationId" | "stealthPrivKey">,
  ): Promise<PublisherInclusionPath> {
    return this.publisher().getInclusionPath(await computeReputationLeaf(input));
  }

  /** Attest a reputation trait to a stealth identity (delegates to schemas). */
  attest(opts: Parameters<SchemasService["attest"]>[0]): Promise<string> {
    return this.schemas.attest(opts);
  }

  /** Submit a precomputed V2 reputation proof for on-chain verification. */
  async verifyOnChain(opts: VerifyReputationInputs): Promise<string> {
    const signer = this.ctx.requireSigner();
    return this.ctx.contracts.reputationVerifier.verifyReputation({
      ...opts,
      groth16VerifierId: this.ctx.config.contracts.groth16Verifier,
      signer,
    });
  }

  /** Read the latest published reputation Merkle root, or null if none. */
  async getLatestRoot(opts?: { source?: string }): Promise<Uint8Array | null> {
    const source = opts?.source ?? (await this.ctx.requireSigner().publicKey());
    return this.ctx.contracts.reputationVerifier.getLatestRoot(source);
  }

  /**
   * Generate a V2 reputation proof. Requires an artifact resolver
   * (`new OpaqueClient({ artifacts })`); otherwise throws {@link NotWiredError}.
   * Pass `usePublisher: true` to prove against the real Merkle path fetched
   * from the configured publisher instead of the single-leaf tree.
   */
  async prove(
    input: ReputationProveInput & { usePublisher?: boolean },
  ): Promise<ReputationProof> {
    if (!this.ctx.artifacts) {
      throw new NotWiredError(
        "Reputation proof generation",
        "Construct OpaqueClient with { artifacts } (a circuit ArtifactResolver) to enable proving.",
      );
    }
    const { usePublisher, ...proveInput } = input;
    if (usePublisher && !proveInput.inclusion) {
      const path = await this.getInclusionPath(proveInput);
      proveInput.inclusion = {
        root: path.root,
        pathElements: path.pathElements,
        pathIndices: path.pathIndices,
      };
    }
    return proveReputationV2({ input: proveInput, artifacts: this.ctx.artifacts });
  }

  /** Generate a proof and submit it on-chain in one call. Returns the tx hash. */
  async proveAndVerify(
    input: ReputationProveInput & { usePublisher?: boolean },
  ): Promise<string> {
    return this.verifyOnChain(await this.prove(input));
  }
}
