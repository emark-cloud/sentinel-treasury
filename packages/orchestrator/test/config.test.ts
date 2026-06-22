import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { loadConfig, loadEnv } from '../src/config/env.js';

// Flip the once-only dotenv guard up front so the repo `.env` can't repopulate vars we delete
// per-test (dotenv only runs on the first `loadEnv`; after this it is a no-op).
beforeAll(() => {
  loadEnv();
});

const REQUIRED = {
  CSPR_CLOUD_ACCESS_TOKEN: 'tok',
  AGENT_PUBLIC_KEY: 'agent',
  OWNER_PUBLIC_KEY: 'owner',
  VAULT_CONTRACT_HASH: 'vault',
  AUDITLOG_CONTRACT_HASH: 'audit',
  CSPR_TRADE_ROUTER_HASH: 'router',
  WISE_LENDING_STAKING_HASH: 'staking',
  WCSPR_HASH: 'wcspr',
  STABLE_TOKEN_HASH: 'stable',
  STYKS_PRICE_FEED_HASH: 'styks',
};

const saved: Record<string, string | undefined> = {};
const ALL_KEYS = [
  ...Object.keys(REQUIRED),
  'CASPER_NETWORK',
  'X402_NETWORK',
  'NODE_RPC_URL',
  'PREMIUM_ENDPOINT_URL',
  'GEMINI_MODEL',
];

beforeEach(() => {
  for (const k of ALL_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ALL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadConfig', () => {
  it('throws when a required var is missing', () => {
    expect(() => loadConfig()).toThrow(/missing required env var/);
  });

  it('builds a typed config with defaults', () => {
    Object.assign(process.env, REQUIRED);
    const cfg = loadConfig();
    expect(cfg.network).toBe('casper-test');
    expect(cfg.x402Network).toBe('casper:casper-test');
    expect(cfg.nodeRpcUrl).toContain('rpc');
    expect(cfg.contracts.vault).toBe('vault');
    expect(cfg.contracts.styks).toBe('styks');
    expect(cfg.gemini.model).toBe('gemini-2.5-flash');
    expect(cfg.premiumEndpointUrl).toBeUndefined();
  });

  it('respects overrides', () => {
    Object.assign(process.env, REQUIRED, {
      CASPER_NETWORK: 'casper',
      PREMIUM_ENDPOINT_URL: 'http://x/premium',
    });
    const cfg = loadConfig();
    expect(cfg.network).toBe('casper');
    expect(cfg.premiumEndpointUrl).toBe('http://x/premium');
  });
});
