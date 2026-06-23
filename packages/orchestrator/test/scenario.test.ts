import { describe, it, expect } from 'vitest';
import { DataService } from '../src/data/dataService.js';
import { Scout } from '../src/agents/scout.js';
import { MemoryArtifactStore } from '../src/store/artifactStore.js';
import { deterministicVerdict } from '../src/decision/ruleEngine.js';
import type { DecisionPolicy } from '../src/decision/types.js';
import {
  buildScenario,
  demoBalances,
  exchangeRateInputs,
  SCENARIOS,
} from '../src/scenario/scenarios.js';
import type { ScenarioKind } from '../src/scenario/scenarios.js';

const POLICY: DecisionPolicy = {
  perActionCapUsd: 250,
  dailyCapUsd: 1000,
  dayRemainingUsd: 1000,
  maxSlippageBps: 100,
  minScsprBps: 1000,
  maxScsprBps: 7000,
  csprBufferCspr: 75,
  minTradeUsd: 1,
};

async function perceive(kind: ScenarioKind) {
  const scn = buildScenario(kind, { nowSec: 1_000_000 });
  const raw = await new DataService(scn.sources).collect();
  const store = new MemoryArtifactStore();
  const { snapshot, perceptionHash } = await new Scout(store).perceive({
    cycleId: `cyc-${kind}`,
    raw,
    premium: scn.premium,
    volatility: scn.volatility,
    now: 1_000_000_000,
  });
  return { scn, raw, snapshot, perceptionHash, store };
}

describe('scenario harness', () => {
  it('injects a market event with honest (scenario, not Styks) price provenance', async () => {
    const { snapshot } = await perceive('price-shock');
    const twapProv = snapshot.provenance.find((p) => p.field === 'csprUsdTwap');
    expect(twapProv).toBeDefined();
    // Injected price is never presented as a VERIFIED Styks read (spec §15.3 honesty rule).
    expect(twapProv!.label).toBe('ESTIMATED');
    expect(twapProv!.source).toBe('scenario-injection');
  });

  it('flows through the real Scout: hash is reproducible and stored for verification', async () => {
    const { snapshot, perceptionHash, store } = await perceive('calm');
    const stored = await store.getByHash(perceptionHash);
    expect(stored?.artifact).toEqual(snapshot);
  });

  it('price-shock lands Stressed but keeps divergence under the oracle trust ceiling', async () => {
    const { snapshot } = await perceive('price-shock');
    expect(deterministicVerdict(snapshot, POLICY).regime).toBe('Stressed');
    expect(snapshot.twapSpotDivergenceBps).toBeLessThan(500);
  });

  it('calm lands Calm with tight divergence', async () => {
    const { snapshot } = await perceive('calm');
    expect(deterministicVerdict(snapshot, POLICY).regime).toBe('Calm');
    expect(snapshot.twapSpotDivergenceBps).toBeLessThan(500);
  });

  it('liquidity-crunch lands Elevated with a steep impact curve', async () => {
    const { snapshot } = await perceive('liquidity-crunch');
    expect(deterministicVerdict(snapshot, POLICY).regime).toBe('Elevated');
    const last = snapshot.liquidity.priceImpactCurve.at(-1)!;
    expect(last.bps).toBeGreaterThan(SCENARIOS['price-shock'].priceImpactCurve.at(-1)!.bps);
  });

  it('oracle-divergence pushes divergence past the trust ceiling', async () => {
    const { snapshot } = await perceive('oracle-divergence');
    expect(snapshot.twapSpotDivergenceBps).toBeGreaterThan(500);
  });

  it('demoBalances builds the requested allocation', () => {
    const bal = demoBalances({ bookUsd: 10_000, scsprBps: 2000, twapUsd: 0.0304 });
    // 20% of $10k in sCSPR, 80% in WUSDT (6-dec) → ~$8000.
    expect(Number(bal.csprusd) / 1e6).toBeCloseTo(8000, 0);
  });

  it('exchangeRateInputs yields the requested ratio', () => {
    const inputs = exchangeRateInputs(1.052);
    expect(Number(inputs.stakedCspr) / Number(inputs.totalSupply)).toBeCloseTo(1.052, 3);
  });
});
