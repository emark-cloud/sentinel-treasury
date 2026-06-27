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
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

let loaded = false;

/**
 * Walk up from this module toward the filesystem root, returning the first directory
 * that holds a `pnpm-workspace.yaml` (the monorepo root). Returns undefined if none is
 * found. This makes `.env` resolution independent of `process.cwd()` — the runner is
 * launched via `pnpm --filter orchestrator start`, whose cwd is the package, not the
 * repo root where `.env` lives.
 */
function findRepoRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Load `.env` into `process.env` exactly once (idempotent). Safe to call from any entrypoint. */
export function loadEnv(): void {
  if (loaded) return;
  // Prefer the monorepo-root `.env` (stable regardless of cwd); fall back to cwd default.
  const root = findRepoRoot();
  if (root) dotenvConfig({ path: join(root, '.env') });
  else dotenvConfig();
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
  /** Host-local PEM paths for the bounded agent / owner signing keys (spec §8.1). */
  agentSecretKeyPath: string | undefined;
  ownerSecretKeyPath: string | undefined;
  contracts: ContractRegistry;
  execution: ExecutionSettings;
}

/** Execution + guard tunables (spec §8, §11). Gas is in motes (1 CSPR = 1e9 motes). */
export interface ExecutionSettings {
  /** Gas payment for `execute_rebalance` (cross-contract swap is the costly case). */
  rebalancePaymentMotes: number;
  /** Gas payment for the owner `pause` kill switch. */
  pausePaymentMotes: number;
  /** Finality poll interval / overall timeout (ms). */
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** Consecutive reverts that trip the circuit breaker (spec §11). */
  maxConsecutiveReverts: number;
  /** Oracle-staleness guard thresholds (spec §8). */
  maxHeartbeatAgeSec: number;
  maxDivergenceBps: number;
}

function optNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid numeric env var ${name}: ${v}`);
  return n;
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
    agentSecretKeyPath: opt('AGENT_SECRET_KEY_PATH'),
    ownerSecretKeyPath: opt('OWNER_SECRET_KEY_PATH'),
    contracts: {
      vault: req('VAULT_CONTRACT_HASH'),
      auditLog: req('AUDITLOG_CONTRACT_HASH'),
      router: req('CSPR_TRADE_ROUTER_HASH'),
      staking: req('WISE_LENDING_STAKING_HASH'),
      wcspr: req('WCSPR_HASH'),
      stable: req('STABLE_TOKEN_HASH'),
      styks: req('STYKS_PRICE_FEED_HASH'),
    },
    execution: {
      rebalancePaymentMotes: optNum('EXEC_REBALANCE_PAYMENT_MOTES', 20_000_000_000),
      pausePaymentMotes: optNum('EXEC_PAUSE_PAYMENT_MOTES', 2_500_000_000),
      pollIntervalMs: optNum('EXEC_POLL_INTERVAL_MS', 5_000),
      pollTimeoutMs: optNum('EXEC_POLL_TIMEOUT_MS', 180_000),
      maxConsecutiveReverts: optNum('EXEC_MAX_CONSECUTIVE_REVERTS', 3),
      maxHeartbeatAgeSec: optNum('ORACLE_MAX_HEARTBEAT_AGE_SEC', 5_400),
      maxDivergenceBps: optNum('ORACLE_MAX_DIVERGENCE_BPS', 500),
    },
  };
}
