/**
 * `MarketSnapshot` — the Scout agent's output (spec §5.3).
 *
 * The snapshot is canonicalized and blake2b-256 hashed into `Receipt.perceptionHash`;
 * the full JSON is retained off-chain (spec §9). It MUST therefore be plain,
 * JSON-serializable data — the spec's `priceImpactBps: (sizeUsd) => number` is
 * represented here as sampled points (`priceImpactCurve`) so the snapshot is hashable
 * and reproducible.
 */
import type { SignalProvenance } from './provenance.js';
import type { VaultBalances } from './onchain.js';

export type VolatilityWindow = '1h' | '24h';

export interface PriceImpactSample {
  /** Trade size in USD. */
  sizeUsd: number;
  /** Projected price impact in basis points at that size (from MCP pre-trade analysis). */
  bps: number;
}

export interface PremiumSignal {
  /** 0..100 risk index from the x402-gated premium endpoint. */
  riskIndex: number;
  source: 'premium-x402';
  paid: {
    /** Amount paid, base units as a decimal string. */
    amount: string;
    /** Settlement transaction hash on Testnet. */
    settleTx: string;
  };
}

export interface MarketSnapshot {
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** CSPR/USD time-weighted average price from Styks (VERIFIED). */
  csprUsdTwap: number;
  /** CSPR/USD spot from MCP / CSPR.cloud. */
  csprUsdSpot: number;
  /** |spot - twap| / twap, in basis points. */
  twapSpotDivergenceBps: number;
  volatility: {
    window: VolatilityWindow;
    annualizedPct: number;
  };
  liquidity: {
    csprUsdPool: {
      depthUsd: number;
    };
    /** Sampled price-impact curve from MCP `pre_trade_analysis`. */
    priceImpactCurve: PriceImpactSample[];
  };
  /** Present only when an x402 paid pull succeeded this cycle. */
  premiumSignal?: PremiumSignal;
  /** Current vault balances + (off-chain) USD valuation. */
  vault: VaultBalances;
  /** Per-field provenance — VERIFIED | COMPUTED | ESTIMATED. */
  provenance: SignalProvenance[];
}
