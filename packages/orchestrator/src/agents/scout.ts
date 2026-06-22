/**
 * Scout agent (spec §6.1, §5.3) — the perception role. It does **not** opine on allocation; it
 * gathers + normalizes the raw inputs into a `MarketSnapshot`, labels every field's provenance
 * (VERIFIED | COMPUTED | ESTIMATED — never presenting an estimate as fact), validates against the
 * shared schema, blake2b-hashes it into `perception_hash`, and retains the full JSON in the
 * artifact store so the hash is later verifiable on-chain (spec §9.2).
 *
 * The hash equality `blake2b(MarketSnapshot) == Receipt.perceptionHash` is the proof contract, so
 * the snapshot here must be exactly what gets hashed — assembled from plain, reproducible data.
 */
import { hashCanonical, validate } from '@sentinel/shared';
import type { MarketSnapshot, SignalProvenance, VolatilityWindow } from '@sentinel/shared';
import { PRICE_SCALE } from '../data/onchainReader.js';
import type { RawPerception } from '../data/dataService.js';
import type { ArtifactStore } from '../store/artifactStore.js';
import type { PremiumPullResult } from '../x402/client.js';

/** Volatility estimate (ESTIMATED) — supplied by a vol model / price-history feed (Phase 4 input). */
export interface VolatilityEstimate {
  window: VolatilityWindow;
  annualizedPct: number;
}

export interface PerceiveInput {
  cycleId: string;
  raw: RawPerception;
  /** Result of an x402 paid pull this cycle, if one happened. */
  premium?: PremiumPullResult;
  /** Volatility estimate; defaults to a flat 24h placeholder labelled ESTIMATED. */
  volatility?: VolatilityEstimate;
  now?: number;
}

export interface PerceiveResult {
  snapshot: MarketSnapshot;
  /** Hex blake2b-256 of the snapshot == on-chain `perception_hash`. */
  perceptionHash: string;
}

/** USD micros (1e6) → USD as a number. */
function microsToUsd(micros: bigint): number {
  return Number(micros) / Number(PRICE_SCALE);
}

/** |spot − twap| / twap, in basis points. Returns 0 when twap is 0. */
export function divergenceBps(twapUsd: number, spotUsd: number): number {
  if (twapUsd === 0) return 0;
  return Math.round((Math.abs(spotUsd - twapUsd) / twapUsd) * 10_000);
}

export class Scout {
  constructor(private readonly store: ArtifactStore) {}

  /** Assemble, validate, hash, and persist the `MarketSnapshot` for a cycle. */
  async perceive(input: PerceiveInput): Promise<PerceiveResult> {
    const { raw } = input;
    const now = input.now ?? Date.now();
    const provenance: SignalProvenance[] = [];

    // --- price (Styks TWAP, or fallback) ---
    let twapUsd: number;
    if (raw.twap) {
      twapUsd = microsToUsd(raw.twap.micros);
      const verified = raw.twap.source.startsWith('styks');
      provenance.push({
        field: 'csprUsdTwap',
        label: verified ? 'VERIFIED' : 'ESTIMATED',
        source: raw.twap.source,
      });
    } else {
      // No readable TWAP — fall back to DEX spot, labelled honestly so it's never mistaken for
      // the authoritative Styks read. The decision layer applies the oracle-staleness guard.
      twapUsd = raw.market.spotUsd;
      provenance.push({ field: 'csprUsdTwap', label: 'ESTIMATED', source: 'fallback-spot' });
    }

    const spotUsd = raw.market.spotUsd;
    provenance.push({ field: 'csprUsdSpot', label: 'VERIFIED', source: 'cspr.trade-mcp' });

    const twapSpotDivergenceBps = divergenceBps(twapUsd, spotUsd);
    provenance.push({ field: 'twapSpotDivergenceBps', label: 'COMPUTED', source: 'twap∧spot' });

    const volatility = input.volatility ?? { window: '24h' as VolatilityWindow, annualizedPct: 0 };
    provenance.push({ field: 'volatility.annualizedPct', label: 'ESTIMATED', source: 'vol-model' });

    provenance.push({
      field: 'liquidity.csprUsdPool.depthUsd',
      label: 'VERIFIED',
      source: 'cspr.trade-mcp',
    });
    provenance.push({
      field: 'liquidity.priceImpactCurve',
      label: 'ESTIMATED',
      source: 'cspr.trade-mcp:pre_trade_analysis',
    });

    provenance.push({ field: 'vault.cspr', label: 'VERIFIED', source: 'cspr.cloud' });
    provenance.push({ field: 'vault.scspr', label: 'VERIFIED', source: 'cspr.cloud' });
    provenance.push({ field: 'vault.csprusd', label: 'VERIFIED', source: 'cspr.cloud' });

    const base: Omit<MarketSnapshot, 'premiumSignal'> = {
      timestamp: now,
      csprUsdTwap: twapUsd,
      csprUsdSpot: spotUsd,
      twapSpotDivergenceBps,
      volatility,
      liquidity: {
        csprUsdPool: { depthUsd: raw.market.depthUsd },
        priceImpactCurve: raw.priceImpactCurve,
      },
      vault: raw.balances,
      provenance,
    };

    let snapshot: MarketSnapshot;
    if (input.premium) {
      provenance.push({
        field: 'premiumSignal.riskIndex',
        label: 'VERIFIED',
        source: 'premium-x402',
      });
      snapshot = {
        ...base,
        premiumSignal: {
          riskIndex: input.premium.signal.riskIndex,
          source: 'premium-x402',
          paid: {
            amount: input.premium.amountMotes.toString(),
            settleTx: input.premium.settleTx,
          },
        },
      };
    } else {
      snapshot = base;
    }

    const result = validate<MarketSnapshot>('marketSnapshot', snapshot);
    if (!result.valid) {
      throw new Error(`Scout produced an invalid MarketSnapshot: ${result.errors?.join('; ')}`);
    }

    const perceptionHash = hashCanonical(snapshot);
    const storedHash = await this.store.putSnapshot(input.cycleId, snapshot);
    // Sanity: the store hashes the same canonical JSON, so these must agree.
    if (storedHash !== perceptionHash) {
      throw new Error(`perception hash mismatch: ${storedHash} != ${perceptionHash}`);
    }

    return { snapshot, perceptionHash };
  }
}
