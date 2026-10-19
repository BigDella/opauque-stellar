import { describe, it, expect } from "vitest";
import { resolveConfig, ConfigError, TESTNET_DEPLOYMENT } from "../../src/index";

describe("config resolution", () => {
  it("resolves testnet from baked defaults", () => {
    const c = resolveConfig({ network: "testnet" });
    expect(c.passphrase).toBe("Test SDF Network ; September 2015");
    expect(c.rpcUrls[0]).toContain("soroban-testnet");
    expect(c.contracts.privacyPool).toBe(TESTNET_DEPLOYMENT.contracts.privacyPool);
    expect(c.pool.scope).toBe(1);
    expect(c.relayerGatewayUrls.length).toBeGreaterThan(0);
    expect(c.startLedger).toBe(TESTNET_DEPLOYMENT.deploymentLedger);
    expect(c.contractVersions).toBeDefined();
    expect(c.contractVersions!.privacyPool).toBe(1);
    expect(c.skipVersionCheck).toBe(false);
  });

  it("applies overrides over baked defaults", () => {
    const c = resolveConfig({
      network: "testnet",
      rpcUrls: ["https://my-rpc.example.com"],
      contracts: { privacyPool: "CZZZ" },
      relayerGatewayUrls: ["https://my-gateway.example.com"],
      startLedger: 9_000_000,
    });
    expect(c.rpcUrls).toEqual(["https://my-rpc.example.com"]);
    expect(c.contracts.privacyPool).toBe("CZZZ");
    // unspecified contracts still come from the baked deployment
    expect(c.contracts.reputationVerifier).toBe(
      TESTNET_DEPLOYMENT.contracts.reputationVerifier,
    );
    expect(c.relayerGatewayUrls).toEqual(["https://my-gateway.example.com"]);
    expect(c.startLedger).toBe(9_000_000);
  });

  it("rejects mainnet without explicit providers and contracts", () => {
    expect(() => resolveConfig({ network: "mainnet" })).toThrow(ConfigError);
  });

  it("rejects an unknown network", () => {
    // @ts-expect-error intentional invalid network
    expect(() => resolveConfig({ network: "regtest" })).toThrow(ConfigError);
  });

  const fullContracts = {
    stealthRegistry: "C1",
    stealthAnnouncer: "C2",
    groth16Verifier: "C3",
    reputationVerifier: "C4",
    schemaRegistry: "C5",
    attestationEngineV2: "C6",
    poolVerifier: "C7",
    privacyPool: "C8",
    relayerRegistry: "C9",
  };

  it("rejects a custom network without explicit pool wiring", () => {
    expect(() =>
      resolveConfig({
        network: "mainnet",
        rpcUrls: ["https://mainnet.example.com/rpc"],
        horizonUrls: ["https://horizon.example.com"],
        contracts: fullContracts,
      }),
    ).toThrow(/pool\.scope, pool\.nativeSac/);
  });

  it("uses explicit pool wiring on a custom network", () => {
    const c = resolveConfig({
      network: "mainnet",
      rpcUrls: ["https://mainnet.example.com/rpc"],
      horizonUrls: ["https://horizon.example.com"],
      contracts: fullContracts,
      pool: { scope: 7, nativeSac: "CSAC" },
    });
    expect(c.pool).toEqual({ scope: 7, nativeSac: "CSAC" });
    expect(c.pool.nativeSac).not.toBe(c.contracts.privacyPool);
  });

  it("accepts mainnet when providers and contracts are supplied", () => {
    const full = {
      stealthRegistry: "C1",
      stealthAnnouncer: "C2",
      groth16Verifier: "C3",
      reputationVerifier: "C4",
      schemaRegistry: "C5",
      attestationEngineV2: "C6",
      poolVerifier: "C7",
      privacyPool: "C8",
      relayerRegistry: "C9",
    };
    const c = resolveConfig({
      network: "mainnet",
      rpcUrls: ["https://mainnet.example.com/rpc"],
      horizonUrls: ["https://horizon.example.com"],
      contracts: full,
      pool: { scope: 1, nativeSac: "CSAC" },
    });
    expect(c.contracts).toEqual(full);
    expect(c.passphrase).toContain("Public Global Stellar Network");
  });
});
