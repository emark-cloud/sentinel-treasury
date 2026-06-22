/**
 * Typed configuration registry for the orchestrator (spec §13, CLAUDE.md config registry).
 *
 * All on-chain integration is bound to **package hashes** (upgradable contracts change their
 * active contract hash; the package hash is stable — abi-spike.md). The CSPR.cloud client
 * resolves package → active contract hash at runtime.
 *
 * Values come from the process environment; `.env` is loaded once via `loadEnv()`. Nothing
 * here reads secret key material — signing keys stay on the execution host and are loaded by
 * the execution service (Phase 5), never by the perception layer.
 */
import { config as dotenvConfig } from 'dotenv';

let loaded = false;

/** Load `.env` into `process.env` exactly once (idempotent). Safe to call from any entrypoint. */
export function loadEnv(): void {
  if (loaded) return;
  dotenvConfig();
  loaded = true;
}

/** A 32-byte contract/package hash as lowercase hex, no prefix. */
export type PackageHash = string;

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

/** Casper Testnet contract package hashes the perception/execution layers act on (abi-spike.md). */
export interface ContractRegistry {
  vault: PackageHash;
  auditLog: PackageHash;
  /** CSPR.trade Router (Mode A swaps). */
  router: PackageHash;
  /** Wise Lending liquid staking == sCSPR CEP-18 package. */
  staking: PackageHash;
  /** Wrapped CSPR — first router hop + x402 payment asset. */
  wcspr: PackageHash;
  /** WUSDT — Testnet stable refuge in place of csprUSD (D-005). */
  stable: PackageHash;
  /** Styks price feed — `get_twap_price("CSPRUSD")`. */
  styks: PackageHash;
}

/** Full orchestrator configuration, validated at load. */
export interface OrchestratorConfig {
  network: string; // casper-test
  x402Network: string; // casper:casper-test
  nodeRpcUrl: string;
  csprCloudAccessToken: string;
  csprCloudBaseUrl: string;
  csprTradeMcpEndpoint: string;
  x402FacilitatorUrl: string;
  premiumEndpointUrl: string | undefined;
  gemini: { apiKey: string; model: string };
  agentPublicKey: string;
  ownerPublicKey: string;
  contracts: ContractRegistry;
}

/**
 * Build the config from the environment. Throws if a required value is missing so a
 * misconfigured host fails fast at startup rather than mid-cycle.
 */
export function loadConfig(): OrchestratorConfig {
  loadEnv();
  return {
    network: opt('CASPER_NETWORK') ?? 'casper-test',
    x402Network: opt('X402_NETWORK') ?? 'casper:casper-test',
    nodeRpcUrl: opt('NODE_RPC_URL') ?? 'https://node.testnet.cspr.cloud/rpc',
    csprCloudAccessToken: req('CSPR_CLOUD_ACCESS_TOKEN'),
    csprCloudBaseUrl: opt('CSPR_CLOUD_BASE_URL') ?? 'https://api.testnet.cspr.cloud',
    csprTradeMcpEndpoint: opt('CSPR_TRADE_MCP_ENDPOINT') ?? 'http://127.0.0.1:3001/mcp',
    x402FacilitatorUrl: opt('X402_FACILITATOR_URL') ?? 'https://x402-facilitator.cspr.cloud',
    premiumEndpointUrl: opt('PREMIUM_ENDPOINT_URL'),
    gemini: {
      apiKey: opt('GEMINI_API_KEY') ?? '',
      model: opt('GEMINI_MODEL') ?? 'gemini-2.5-flash',
    },
    agentPublicKey: req('AGENT_PUBLIC_KEY'),
    ownerPublicKey: req('OWNER_PUBLIC_KEY'),
    contracts: {
      vault: req('VAULT_CONTRACT_HASH'),
      auditLog: req('AUDITLOG_CONTRACT_HASH'),
      router: req('CSPR_TRADE_ROUTER_HASH'),
      staking: req('WISE_LENDING_STAKING_HASH'),
      wcspr: req('WCSPR_HASH'),
      stable: req('STABLE_TOKEN_HASH'),
      styks: req('STYKS_PRICE_FEED_HASH'),
    },
  };
}
