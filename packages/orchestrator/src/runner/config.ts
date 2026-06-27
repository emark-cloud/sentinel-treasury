/**
 * Runner-specific configuration — the autonomous-loop knobs layered on top of the base
 * {@link loadConfig} registry (RPC, CSPR.cloud, contracts, signing keys). Everything here has a
 * safe default so a minimally-configured host still starts; the deployed D-015 envelope ($50/$200
 * caps, 1% slippage, 15–70% sCSPR band) is the policy default.
 */
import { join } from 'node:path';
import type { DecisionPolicy } from '../decision/types.js';

function optNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid numeric env var ${name}: ${v}`);
  return n;
}

function optStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export interface RunnerConfig {
  /** Cadence between batches (ms); default 30 min, matching the Styks heartbeat. */
  intervalMs: number;
  /** Port the runner's HTTP + SSE surface binds to (dashboard proxies to it). */
  httpPort: number;
  /** Directory for the cycle journal, artifact store, depositor registry, and cycle history. */
  dataDir: string;
  /** Seed depositors (account hashes or public keys), comma-separated in `RUNNER_ACCOUNTS`. */
  accountSeed: string[];
  /** Drop empty (redeemed / never-funded) ledgers from each batch. */
  skipEmpty: boolean;
  /** The guardrail envelope applied per account off-chain (the contract enforces the real clamp). */
  policy: DecisionPolicy;
  /** sCSPR→CSPR rate fallback when the live read fails (the loop overrides per cycle when readable). */
  exchangeRateFallback: number;
}

export function loadRunnerConfig(): RunnerConfig {
  const dataDir = optStr('RUNNER_DATA_DIR', join(process.cwd(), '.sentinel-runner'));
  const dailyCapUsd = optNum('RUNNER_DAILY_CAP_USD', 200);
  return {
    intervalMs: optNum('RUNNER_INTERVAL_MS', 1_800_000),
    // Railway (and most PaaS) inject the bind port as `PORT`; fall back to `RUNNER_PORT`, then 3002.
    httpPort: optNum('PORT', optNum('RUNNER_PORT', 3002)),
    dataDir,
    accountSeed: optStr('RUNNER_ACCOUNTS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    skipEmpty: optStr('RUNNER_SKIP_EMPTY', 'true') !== 'false',
    policy: {
      perActionCapUsd: optNum('RUNNER_PER_ACTION_CAP_USD', 50),
      dailyCapUsd,
      // Off-chain we assume full daily headroom each batch; the contract enforces the real
      // per-account daily cap and reverts an over-spend, so this can only under-act, never over.
      dayRemainingUsd: dailyCapUsd,
      maxSlippageBps: optNum('RUNNER_MAX_SLIPPAGE_BPS', 100),
      minScsprBps: optNum('RUNNER_MIN_SCSPR_BPS', 1500),
      maxScsprBps: optNum('RUNNER_MAX_SCSPR_BPS', 7000),
      csprBufferCspr: optNum('RUNNER_CSPR_BUFFER_CSPR', 75),
      minTradeUsd: optNum('RUNNER_MIN_TRADE_USD', 1),
    },
    exchangeRateFallback: optNum('RUNNER_SCSPR_RATE_FALLBACK', 1.052),
  };
}
