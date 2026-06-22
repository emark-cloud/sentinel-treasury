import { describe, it, expect } from 'vitest';
import type { MarketSnapshot, AllocationProposal, RiskVerdict } from '@sentinel/shared';
import {
  REGIME_BANDS,
  fallbackAllocation,
  regimeRiskScore,
  classifyRegime,
  deterministicVerdict,
  clampTargetBps,
  critiqueProposal,
} from '../src/decision/ruleEngine.js';
import type { DecisionPolicy } from '../src/decision/types.js';

const policy: DecisionPolicy = {
  perActionCapUsd: 100,
  dailyCapUsd: 500,
  dayRemainingUsd: 500,
  maxSlippageBps: 100,
  minScsprBps: 0,
  maxScsprBps: 10000,
};

function snap(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    timestamp: 1,
    csprUsdTwap: 1,
    csprUsdSpot: 1,
    twapSpotDivergenceBps: 0,
    volatility: { window: '24h', annualizedPct: 0 },
    liquidity: { csprUsdPool: { depthUsd: 100000 }, priceImpactCurve: [] },
    vault: { cspr: '0', scspr: '0', csprusd: '0' },
    provenance: [],
    ...overrides,
  };
}

describe('regimeRiskScore / classifyRegime', () => {
  it('calm when no risk signals', () => {
    expect(regimeRiskScore(snap())).toBe(0);
    expect(classifyRegime(0)).toBe('Calm');
  });

  it('rises with divergence, volatility, and premium index', () => {
    const score = regimeRiskScore(
      snap({
        twapSpotDivergenceBps: 1000, // +40
        volatility: { window: '24h', annualizedPct: 200 }, // +30
        premiumSignal: {
          riskIndex: 100,
          source: 'premium-x402',
          paid: { amount: '1', settleTx: 'x' },
        }, // +30
      }),
    );
    expect(score).toBe(100);
    expect(classifyRegime(score)).toBe('Stressed');
  });

  it('thresholds map to regimes', () => {
    expect(classifyRegime(24)).toBe('Calm');
    expect(classifyRegime(25)).toBe('Elevated');
    expect(classifyRegime(54)).toBe('Elevated');
    expect(classifyRegime(55)).toBe('Stressed');
  });
});

describe('deterministicVerdict', () => {
  it('caps hard limits inside the regime band and per-action cap', () => {
    const v = deterministicVerdict(
      snap({ twapSpotDivergenceBps: 1000, volatility: { window: '24h', annualizedPct: 200 } }),
      policy,
    );
    expect(v.regime).toBe('Stressed');
    expect(v.hardLimits.maxScsprBps).toBe(REGIME_BANDS.Stressed.maxScsprBps);
    expect(v.hardLimits.maxActionUsd).toBe(policy.perActionCapUsd);
  });
});

describe('clampTargetBps', () => {
  const verdict: RiskVerdict['hardLimits'] = { maxScsprBps: 10000, maxActionUsd: 100 };

  it('pulls an over-band proposal back into the regime band', () => {
    const clamped = clampTargetBps(
      { scspr: 9000, csprusd: 1000, csprBuffer: 0 },
      'Calm',
      policy,
      verdict,
    );
    expect(clamped.scspr).toBe(REGIME_BANDS.Calm.maxScsprBps); // 7000
    expect(clamped.scspr + clamped.csprusd + clamped.csprBuffer).toBe(10000);
  });

  it('respects the Risk hard limit when tighter than the band', () => {
    const clamped = clampTargetBps({ scspr: 7000, csprusd: 3000, csprBuffer: 0 }, 'Calm', policy, {
      maxScsprBps: 5000,
      maxActionUsd: 100,
    });
    expect(clamped.scspr).toBe(5000);
    expect(clamped.csprusd).toBe(5000);
  });

  it('floors below-band proposals to the band minimum', () => {
    const clamped = clampTargetBps(
      { scspr: 0, csprusd: 10000, csprBuffer: 0 },
      'Calm',
      policy,
      verdict,
    );
    expect(clamped.scspr).toBe(REGIME_BANDS.Calm.minScsprBps); // 4000
  });
});

describe('critiqueProposal', () => {
  const verdict: RiskVerdict = {
    regime: 'Calm',
    riskScore: 10,
    drivers: [],
    hardLimits: { maxScsprBps: 7000, maxActionUsd: 100 },
    rationale: '',
  };
  function proposal(overrides: Partial<AllocationProposal> = {}): AllocationProposal {
    return {
      targetBps: { scspr: 6000, csprusd: 4000, csprBuffer: 0 },
      action: { kind: 'NoOp', asset: 'CSPR', amount: '0', target: '' },
      expectedSlippageBps: 50,
      rationale: '',
      ...overrides,
    };
  }

  it('approves a within-band, within-slippage proposal', () => {
    expect(critiqueProposal(proposal(), verdict, policy).approved).toBe(true);
  });

  it('rejects a proposal outside the regime band', () => {
    const c = critiqueProposal(
      proposal({ targetBps: { scspr: 9000, csprusd: 1000, csprBuffer: 0 } }),
      verdict,
      policy,
    );
    expect(c.approved).toBe(false);
    expect(c.reasons.some((r) => r.includes('band'))).toBe(true);
  });

  it('rejects a proposal above the slippage ceiling', () => {
    const c = critiqueProposal(proposal({ expectedSlippageBps: 250 }), verdict, policy);
    expect(c.approved).toBe(false);
    expect(c.reasons.some((r) => r.includes('slippage'))).toBe(true);
  });

  it('rejects bps that do not sum to 10000', () => {
    const c = critiqueProposal(
      proposal({ targetBps: { scspr: 6000, csprusd: 3000, csprBuffer: 0 } }),
      verdict,
      policy,
    );
    expect(c.approved).toBe(false);
    expect(c.reasons.some((r) => r.includes('sum'))).toBe(true);
  });
});

describe('fallbackAllocation', () => {
  it('returns regime-appropriate, summing-to-10000 bands', () => {
    for (const regime of ['Calm', 'Elevated', 'Stressed'] as const) {
      const a = fallbackAllocation(regime);
      expect(a.scspr + a.csprusd + a.csprBuffer).toBe(10000);
      expect(a.scspr).toBeGreaterThanOrEqual(REGIME_BANDS[regime].minScsprBps);
      expect(a.scspr).toBeLessThanOrEqual(REGIME_BANDS[regime].maxScsprBps);
    }
  });
});
