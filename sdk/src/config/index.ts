/**
 * Injected SDK configuration. The SDK reads no ambient globals (no
 * `import.meta.env`, no module-level singletons): every chain detail comes from
 * an {@link OpaqueConfig} resolved here into a complete, validated
 * {@link ResolvedConfig}.
 */
import { ConfigError } from "../errors/index";
import {
  NETWORK_PRESETS,
  type NetworkPreset,
  type OpaqueNetwork,
} from "./networks";
import {
  DEPLOYMENTS,
  type ContractAddresses,
  type ContractVersions,
  type NetworkDeployment,
  type PoolWiring,
  type RelayerWiring,
} from "./addresses";

export type { OpaqueNetwork, NetworkPreset } from "./networks";
export type {
  ContractAddresses,
  ContractVersions,
  NetworkDeployment,
  PoolWiring,
  RelayerWiring,
} from "./addresses";
export { NETWORK_PRESETS } from "./networks";
export { DEPLOYMENTS, TESTNET_DEPLOYMENT } from "./addresses";

export interface OpaqueConfig {
  /** Target Stellar network. */
  network: OpaqueNetwork;
  /** Override Soroban RPC endpoints (defaults to the network preset). */
  rpcUrls?: string[];
  /** Override Horizon endpoints (defaults to the network preset). */
  horizonUrls?: string[];
  /** Override individual contract addresses (defaults to the baked deployment). */
  contracts?: Partial<ContractAddresses>;
  /** Override relayer-market gateway endpoints. */
  relayerGatewayUrls?: string[];
  /**
   * Privacy-pool wiring (commitment scope + native XLM SAC id). Required on
   * networks without a baked deployment; overrides the baked wiring otherwise.
   */
  pool?: Partial<PoolWiring>;
  /** Base URL of a reputation-root publisher service, if used. */
  reputationPublisherUrl?: string;
  /** Override the ledger event scans start from (defaults to deployment ledger). */
  startLedger?: number;
  /** Skip the contract-version handshake at client initialization (testing only). */
  skipVersionCheck?: boolean;
}

export interface ResolvedConfig {
  network: OpaqueNetwork;
  passphrase: string;
  rpcUrls: string[];
  horizonUrls: string[];
  contracts: ContractAddresses;
  pool: PoolWiring;
  relayer: RelayerWiring;
  relayerGatewayUrls: string[];
  reputationPublisherUrl?: string;
  startLedger: number;
  contractVersions?: ContractVersions;
  skipVersionCheck: boolean;
}

function mergeContracts(
  base: ContractAddresses | undefined,
  overrides: Partial<ContractAddresses> | undefined,
): ContractAddresses {
  const merged = { ...(base ?? {}), ...(overrides ?? {}) } as Record<
    keyof ContractAddresses,
    string | undefined
  >;
  const keys: (keyof ContractAddresses)[] = [
    "stealthRegistry",
    "stealthAnnouncer",
    "groth16Verifier",
    "reputationVerifier",
    "schemaRegistry",
    "attestationEngineV2",
    "poolVerifier",
    "privacyPool",
    "relayerRegistry",
  ];
  const missing = keys.filter((k) => !merged[k]);
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing contract address(es): ${missing.join(", ")}. ` +
        `Pass them via config.contracts for this network.`,
    );
  }
  return merged as ContractAddresses;
}

function resolvePool(
  network: OpaqueNetwork,
  base: PoolWiring | undefined,
  overrides: Partial<PoolWiring> | undefined,
): PoolWiring {
  const scope = overrides?.scope ?? base?.scope;
  const nativeSac = overrides?.nativeSac ?? base?.nativeSac;
  const missing: string[] = [];
  if (scope === undefined) missing.push("pool.scope");
  if (!nativeSac) missing.push("pool.nativeSac");
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing pool wiring for ${network}: ${missing.join(", ")}. ` +
        `Pass them via config.pool (the native XLM SAC id is not the pool contract id).`,
    );
  }
  return { scope: scope as number, nativeSac: nativeSac as string };
}

/**
 * Resolve user config into a complete, validated configuration: network preset +
 * baked deployment + explicit overrides. Throws {@link ConfigError} when a
 * required endpoint or contract address is missing (e.g. mainnet usage).
 */
export function resolveConfig(config: OpaqueConfig): ResolvedConfig {
  const preset: NetworkPreset | undefined = NETWORK_PRESETS[config.network];
  if (!preset) {
    throw new ConfigError(`Unknown network: ${String(config.network)}`);
  }
  const deployment: NetworkDeployment | undefined = DEPLOYMENTS[config.network];

  const rpcUrls = config.rpcUrls?.length ? config.rpcUrls : preset.rpcUrls;
  const horizonUrls = config.horizonUrls?.length
    ? config.horizonUrls
    : preset.horizonUrls;

  if (rpcUrls.length === 0) {
    throw new ConfigError(
      `No Soroban RPC URL configured for ${config.network}. Set config.rpcUrls.`,
    );
  }
  if (horizonUrls.length === 0) {
    throw new ConfigError(
      `No Horizon URL configured for ${config.network}. Set config.horizonUrls.`,
    );
  }

  const contracts = mergeContracts(deployment?.contracts, config.contracts);

  if (!deployment && !config.contracts) {
    throw new ConfigError(
      `No baked deployment for ${config.network}; pass config.contracts.`,
    );
  }

  const pool = resolvePool(config.network, deployment?.pool, config.pool);
  const relayer: RelayerWiring = deployment?.relayer ?? {
    minimumStake: 0n,
    unstakeCooldownLedgers: 0,
    maxDeadlineLedgers: 0,
    gatewayUrls: [],
  };

  const relayerGatewayUrls = config.relayerGatewayUrls?.length
    ? config.relayerGatewayUrls
    : relayer.gatewayUrls;

  return {
    network: config.network,
    passphrase: preset.passphrase,
    rpcUrls,
    horizonUrls,
    contracts,
    pool,
    relayer,
    relayerGatewayUrls,
    reputationPublisherUrl: config.reputationPublisherUrl,
    startLedger: config.startLedger ?? deployment?.deploymentLedger ?? 0,
    contractVersions: deployment?.contractVersions,
    skipVersionCheck: config.skipVersionCheck ?? false,
  };
}
