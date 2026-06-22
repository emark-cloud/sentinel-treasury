/**
 * Data Service (spec §3.2, §5.1) — the single seam the Scout reads from. It fans out to the
 * three perception sources (Styks price feed, CSPR.trade MCP market data, CSPR.cloud balances)
 * plus the sCSPR exchange-rate read, and returns a raw bundle the Scout turns into a hashed
 * `MarketSnapshot`. Sources are injected as interfaces so the loop runs against live Testnet,
 * the scenario harness, or test fakes without code changes.
 */
import type { PriceImpactSample, VaultBalances } from '@sentinel/shared';
import type {
  PriceFeed,
  ExchangeRateFeed,
  PriceReading,
  ExchangeRateInputs,
} from './onchainReader.js';
import type { MarketDataProvider, MarketData } from './mcpClient.js';
import type { BalanceReader } from './csprCloud.js';

/** The injectable set of perception sources. */
export interface PerceptionSources {
  priceFeed: PriceFeed;
  exchangeRate: ExchangeRateFeed;
  marketData: MarketDataProvider;
  balances: BalanceReader;
}

/** Raw, un-normalized perception inputs for one cycle. `null` fields mean a source failed. */
export interface RawPerception {
  /** Styks TWAP (or scenario feed); `null` ⇒ no readable price this cycle. */
  twap: PriceReading | null;
  /** Styks heartbeat (unix seconds) for the staleness guard. */
  heartbeat: number | null;
  /** sCSPR exchange-rate inputs (COMPUTED rate); `null` ⇒ fall back to 1:1. */
  exchangeRate: ExchangeRateInputs | null;
  market: MarketData;
  priceImpactCurve: PriceImpactSample[];
  balances: VaultBalances;
}

/** Default trade sizes (USD) sampled for the price-impact curve. */
export const DEFAULT_IMPACT_SIZES_USD = [10, 25, 50, 100, 250] as const;

export class DataService {
  constructor(private readonly sources: PerceptionSources) {}

  /**
   * Collect all perception inputs for a cycle in parallel. Source failures degrade to `null` /
   * empty rather than throwing, so the Scout can still emit a snapshot with honest provenance
   * (and the decision layer can NoOp on a missing price).
   */
  async collect(
    impactSizesUsd: readonly number[] = DEFAULT_IMPACT_SIZES_USD,
  ): Promise<RawPerception> {
    const [twap, heartbeat, exchangeRate, market, priceImpactCurve, balances] = await Promise.all([
      this.sources.priceFeed.readTwap().catch(() => null),
      this.sources.priceFeed.readHeartbeat().catch(() => null),
      this.sources.exchangeRate.readExchangeRate().catch(() => null),
      this.sources.marketData.getMarketData(),
      this.sources.marketData.priceImpactCurve([...impactSizesUsd]).catch(() => []),
      this.sources.balances.readVaultBalances(),
    ]);
    return { twap, heartbeat, exchangeRate, market, priceImpactCurve, balances };
  }
}
