/**
 * Scenario harness (spec §15.3) — the demo's **market-event injection** into the perception layer.
 *
 * HONESTY DISCIPLINE: on a live deployment only the *market event* (price / depth / premium risk
 * index) is injected; the agents' reasoning, the capped on-chain transaction, the x402 settlement,
 * and the receipt are **real on Testnet**. This module composes the same injectable static feeds
 * the perception layer already exposes (`StaticPriceFeed`, `StaticMarketDataProvider`,
 * `StaticExchangeRateFeed`, `StaticBalanceReader`) into a coherent regime, so a scenario flows
 * through the *real* Scout → Deliberator → ExecutionService pipeline rather than a faked cycle.
 *
 * The injected price feed labels its source `scenario-injection`, so the Scout records the TWAP
 * provenance as ESTIMATED — it is never presented as a VERIFIED Styks read. That is the visible
 * tell that the trigger is simulated while everything downstream is real.
 *
 * Scenario design respects the oracle-staleness guard (spec §8): a "shock" widens TWAP/spot
 * divergence but keeps it *under* the trust ceiling, with the regime driven instead by realized
 * volatility and the paid premium risk index. The dedicated `oracle-divergence` scenario crosses
 * the ceiling on purpose, to demonstrate the guard NoOping a cycle it cannot trust.
 */
import type { PriceImpactSample, VaultBalances } from '@sentinel/shared';
import type { PerceptionSources } from '../data/dataService.js';
import type { ExchangeRateInputs } from '../data/onchainReader.js';
import { StaticPriceFeed, StaticExchangeRateFeed } from '../data/onchainReader.js';
import { StaticMarketDataProvider } from '../data/mcpClient.js';
import { StaticBalanceReader } from '../data/csprCloud.js';
import type { VolatilityEstimate } from '../agents/scout.js';
import type { PremiumPullResult } from '../x402/client.js';

export type ScenarioKind = 'calm' | 'price-shock' | 'liquidity-crunch' | 'oracle-divergence';

/** The injected market event for one scenario (the only simulated part of a demo cycle). */
export interface ScenarioDefinition {
  kind: ScenarioKind;
  /** Demo-facing label, tagged so the UI/logs can style it apart from real signals. */
  label: string;
  /** Injected CSPR/USD TWAP (USD). */
  twapUsd: number;
  /** Injected CSPR/USD spot from the DEX (USD). */
  spotUsd: number;
  /** Injected stable-pool depth (≈ USD). */
  depthUsd: number;
  /** Injected price-impact curve sampled at trade sizes (USD → bps). */
  priceImpactCurve: PriceImpactSample[];
  /** Injected realized annualized volatility (%). */
  volatilityPct: number;
  /** Injected paid premium risk index (0..100). */
  premiumRiskIndex: number;
  /** Age of the (injected) Styks heartbeat in seconds — drives the staleness guard. */
  heartbeatAgeSec: number;
}

/**
 * The four canned market events. Numbers mirror the dashboard's demo scenarios so the two demo
 * surfaces tell the same story; the deterministic regime each lands in (via `regimeRiskScore`) is
 * noted alongside.
 */
export const SCENARIOS: Record<ScenarioKind, ScenarioDefinition> = {
  // Calm: tight divergence, modest vol, low premium index → score ≈ 15 → Calm.
  calm: {
    kind: 'calm',
    label: 'demo ▸ calm market',
    twapUsd: 0.0307,
    spotUsd: 0.0309,
    depthUsd: 96_000,
    priceImpactCurve: [
      { sizeUsd: 250, bps: 14 },
      { sizeUsd: 500, bps: 27 },
      { sizeUsd: 1000, bps: 55 },
    ],
    volatilityPct: 38.2,
    premiumRiskIndex: 22,
    heartbeatAgeSec: 240,
  },
  // Price shock: divergence widens but stays under the 500bps trust ceiling; vol + premium drive
  // the regime → score ≈ 57 → Stressed, and the agent still acts (de-risk via the DEX).
  'price-shock': {
    kind: 'price-shock',
    label: 'demo ▸ price shock',
    twapUsd: 0.0304,
    spotUsd: 0.0295,
    depthUsd: 41_000,
    priceImpactCurve: [
      { sizeUsd: 250, bps: 38 },
      { sizeUsd: 500, bps: 81 },
      { sizeUsd: 1000, bps: 173 },
    ],
    volatilityPct: 142.6,
    premiumRiskIndex: 78,
    heartbeatAgeSec: 300,
  },
  // Liquidity crunch: depth collapses and the impact curve steepens; moderate divergence/vol →
  // score ≈ 39 → Elevated. The steep curve forces the sizing layer to shrink the trade.
  'liquidity-crunch': {
    kind: 'liquidity-crunch',
    label: 'demo ▸ liquidity crunch',
    twapUsd: 0.0301,
    spotUsd: 0.0296,
    depthUsd: 18_000,
    priceImpactCurve: [
      { sizeUsd: 250, bps: 96 },
      { sizeUsd: 500, bps: 210 },
      { sizeUsd: 1000, bps: 470 },
    ],
    volatilityPct: 95.0,
    premiumRiskIndex: 58,
    heartbeatAgeSec: 360,
  },
  // Oracle divergence: spot dislocates far past the trust ceiling → the staleness/divergence guard
  // rejects the cycle (NoOp), demonstrating that a bad price never reaches an action.
  'oracle-divergence': {
    kind: 'oracle-divergence',
    label: 'demo ▸ oracle divergence',
    twapUsd: 0.0304,
    spotUsd: 0.0241, // ~20% gap, well past the 500bps ceiling
    depthUsd: 22_000,
    priceImpactCurve: [
      { sizeUsd: 250, bps: 72 },
      { sizeUsd: 500, bps: 160 },
      { sizeUsd: 1000, bps: 360 },
    ],
    volatilityPct: 120.0,
    premiumRiskIndex: 70,
    heartbeatAgeSec: 300,
  },
};

const SCSPR_RATE = 1.052; // CSPR per sCSPR (Wise Lending staking yield).
const DEFAULT_BUFFER_CSPR = 75; // working buffer, excluded from allocation math (spec §1.3).

/** Build `ExchangeRateInputs` whose ratio equals `cssprPerScspr` (default 1.052). */
export function exchangeRateInputs(csprPerScspr = SCSPR_RATE): ExchangeRateInputs {
  return {
    stakedCspr: BigInt(Math.round(csprPerScspr * 1e9)) * 1_000_000_000n,
    totalSupply: 1_000_000_000n * 1_000_000_000n,
  };
}

/**
 * A resting ~$`bookUsd` book at `scsprBps`/`(10000-scsprBps)` (sCSPR / stable), valued at `twapUsd`,
 * with a fixed CSPR working buffer. Lets a demo start from any allocation (e.g. 60/40 calm, or a
 * de-risked 20/80 to show the agent staking back).
 */
export function demoBalances(opts?: {
  bookUsd?: number;
  scsprBps?: number;
  twapUsd?: number;
  bufferCspr?: number;
}): VaultBalances {
  const bookUsd = opts?.bookUsd ?? 10_000;
  const scsprBps = opts?.scsprBps ?? 6000;
  const twapUsd = opts?.twapUsd ?? 0.0307;
  const bufferCspr = opts?.bufferCspr ?? DEFAULT_BUFFER_CSPR;

  const scsprUsd = (bookUsd * scsprBps) / 10_000;
  const stableUsd = bookUsd - scsprUsd;
  const scsprUnits = scsprUsd / (twapUsd * SCSPR_RATE); // sCSPR (9-dec)
  return {
    cspr: String(Math.round(bufferCspr * 1e9)),
    scspr: String(Math.round(scsprUnits * 1e9)),
    csprusd: String(Math.round(stableUsd * 1e6)), // WUSDT (6-dec)
  };
}

function randHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(a);
  } else {
    for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a `PremiumPullResult` carrying the scenario's injected risk index. In a live demo the real
 * `X402Client` performs the paid pull (the settlement is real); the scenario only supplies the
 * *signal value*. Provided here so an offline scenario run still exercises the premium-signal path.
 */
export function scenarioPremium(kind: ScenarioKind): PremiumPullResult {
  return {
    signal: { riskIndex: SCENARIOS[kind].premiumRiskIndex, source: 'premium-x402' },
    settleTx: randHex(32),
    amountMotes: 5_000_000_000n,
    asset: 'WCSPR',
  };
}

export interface ScenarioPerception {
  /** The injected source set, ready to hand to a `DataService`. */
  sources: PerceptionSources;
  /** Volatility estimate for the Scout (ESTIMATED provenance). */
  volatility: VolatilityEstimate;
  /** Injected premium pull for the Scout (the signal value is the simulated part). */
  premium: PremiumPullResult;
  /** Demo label. */
  label: string;
  definition: ScenarioDefinition;
}

/**
 * Compose a full set of injected perception sources for `kind`. Pass the vault `balances` and the
 * sCSPR `exchangeRate` (defaults to a 60/40 $10k book at 1.052) — these are the *real* portfolio
 * state in a live demo; only the market signals are injected here.
 */
export function buildScenario(
  kind: ScenarioKind,
  opts?: {
    balances?: VaultBalances;
    exchangeRate?: ExchangeRateInputs;
    nowSec?: number;
  },
): ScenarioPerception {
  const def = SCENARIOS[kind];
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const balances = opts?.balances ?? demoBalances({ twapUsd: def.twapUsd });

  const sources: PerceptionSources = {
    priceFeed: new StaticPriceFeed(
      BigInt(Math.round(def.twapUsd * 1e6)),
      'scenario-injection',
      nowSec - def.heartbeatAgeSec,
    ),
    exchangeRate: new StaticExchangeRateFeed(opts?.exchangeRate ?? exchangeRateInputs()),
    marketData: new StaticMarketDataProvider(
      { spotUsd: def.spotUsd, depthUsd: def.depthUsd },
      def.priceImpactCurve,
    ),
    balances: new StaticBalanceReader(balances),
  };

  return {
    sources,
    volatility: { window: '1h', annualizedPct: def.volatilityPct },
    premium: scenarioPremium(kind),
    label: def.label,
    definition: def,
  };
}
