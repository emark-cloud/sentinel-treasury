import { describe, it, expect } from 'vitest';
import { hashCanonical, validate } from '@sentinel/shared';
import type { MarketSnapshot } from '@sentinel/shared';
import { Scout, divergenceBps } from '../src/agents/scout.js';
import { MemoryArtifactStore } from '../src/store/artifactStore.js';
import type { RawPerception } from '../src/data/dataService.js';
import type { PremiumPullResult } from '../src/x402/client.js';

function rawFixture(overrides: Partial<RawPerception> = {}): RawPerception {
  return {
    twap: { micros: 1_020_000n, source: 'styks-rpc' }, // $1.02
    heartbeat: 1_700_000_000,
    exchangeRate: { stakedCspr: 1_050_000_000n, totalSupply: 1_000_000_000n },
    market: { spotUsd: 1.0, depthUsd: 250_000 },
    priceImpactCurve: [
      { sizeUsd: 50, bps: 30 },
      { sizeUsd: 100, bps: 61 },
    ],
    balances: { cspr: '100000000000', scspr: '600000000000', csprusd: '400000000' },
    ...overrides,
  };
}

describe('divergenceBps', () => {
  it('computes |spot-twap|/twap in bps', () => {
    expect(divergenceBps(1.0, 1.0)).toBe(0);
    expect(divergenceBps(1.0, 1.05)).toBe(500);
    expect(divergenceBps(0, 1.0)).toBe(0);
  });
});

describe('Scout.perceive', () => {
  it('assembles a schema-valid snapshot whose hash equals the stored perception hash', async () => {
    const store = new MemoryArtifactStore();
    const scout = new Scout(store);
    const { snapshot, perceptionHash } = await scout.perceive({
      cycleId: 'cycle-1',
      raw: rawFixture(),
      now: 1_700_000_000_000,
    });

    expect(validate<MarketSnapshot>('marketSnapshot', snapshot).valid).toBe(true);
    expect(perceptionHash).toBe(hashCanonical(snapshot));

    const stored = await store.getByHash<MarketSnapshot>(perceptionHash);
    expect(stored?.cycleId).toBe('cycle-1');
    expect(hashCanonical(stored?.artifact)).toBe(perceptionHash);
  });

  it('labels Styks price VERIFIED and computes divergence', async () => {
    const scout = new Scout(new MemoryArtifactStore());
    const { snapshot } = await scout.perceive({ cycleId: 'c', raw: rawFixture() });
    expect(snapshot.csprUsdTwap).toBeCloseTo(1.02);
    expect(snapshot.twapSpotDivergenceBps).toBe(196); // |1.0-1.02|/1.02 ≈ 196 bps
    const twapProv = snapshot.provenance.find((p) => p.field === 'csprUsdTwap');
    expect(twapProv).toEqual({ field: 'csprUsdTwap', label: 'VERIFIED', source: 'styks-rpc' });
  });

  it('falls back to spot and labels it honestly when no TWAP is readable', async () => {
    const scout = new Scout(new MemoryArtifactStore());
    const { snapshot } = await scout.perceive({
      cycleId: 'c',
      raw: rawFixture({ twap: null }),
    });
    expect(snapshot.csprUsdTwap).toBe(1.0);
    const twapProv = snapshot.provenance.find((p) => p.field === 'csprUsdTwap');
    expect(twapProv?.label).toBe('ESTIMATED');
    expect(twapProv?.source).toBe('fallback-spot');
  });

  it('embeds the premium signal and its settlement when a paid pull happened', async () => {
    const scout = new Scout(new MemoryArtifactStore());
    const premium: PremiumPullResult = {
      signal: { riskIndex: 73 },
      settleTx: 'abc123',
      amountMotes: 1_000_000_000n,
      asset: 'wcspr',
    };
    const { snapshot } = await scout.perceive({ cycleId: 'c', raw: rawFixture(), premium });
    expect(snapshot.premiumSignal).toEqual({
      riskIndex: 73,
      source: 'premium-x402',
      paid: { amount: '1000000000', settleTx: 'abc123' },
    });
    expect(snapshot.provenance.some((p) => p.field === 'premiumSignal.riskIndex')).toBe(true);
  });

  it('omits premiumSignal when no pull happened', async () => {
    const scout = new Scout(new MemoryArtifactStore());
    const { snapshot } = await scout.perceive({ cycleId: 'c', raw: rawFixture() });
    expect(snapshot.premiumSignal).toBeUndefined();
  });
});
