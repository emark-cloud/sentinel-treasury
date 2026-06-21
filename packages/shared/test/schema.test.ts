import { describe, it, expect } from 'vitest';
import { validate } from '../src/schemas/index.js';
import type { RiskVerdict, AllocationProposal, Decision, MarketSnapshot } from '../src/index.js';

describe('agent-I/O schema validation', () => {
  it('accepts a well-formed RiskVerdict', () => {
    const v: RiskVerdict = {
      regime: 'Stressed',
      riskScore: 78,
      drivers: ['twap-spot divergence 3.1%', 'thin csprUSD depth'],
      hardLimits: { maxScsprBps: 2000, maxActionUsd: 500 },
      rationale: 'Divergence + thin liquidity ⇒ defensive.',
    };
    expect(validate('riskVerdict', v).valid).toBe(true);
  });

  it('rejects a RiskVerdict with an out-of-range bps and reports the path', () => {
    const bad = {
      regime: 'Calm',
      riskScore: 10,
      drivers: [],
      hardLimits: { maxScsprBps: 99999, maxActionUsd: 100 },
      rationale: 'x',
    };
    const res = validate('riskVerdict', bad);
    expect(res.valid).toBe(false);
    expect(res.errors?.join(' ')).toContain('maxScsprBps');
  });

  it('rejects an unknown enum regime', () => {
    const res = validate('riskVerdict', {
      regime: 'Panic',
      riskScore: 10,
      drivers: [],
      hardLimits: { maxScsprBps: 2000, maxActionUsd: 1 },
      rationale: 'x',
    });
    expect(res.valid).toBe(false);
  });

  it('accepts an AllocationProposal with a nested RebalanceAction ($ref resolves)', () => {
    const p: AllocationProposal = {
      targetBps: { scspr: 2000, csprusd: 8000, csprBuffer: 0 },
      action: {
        kind: 'SwapToStable',
        asset: 'sCSPR',
        amount: '500000000000',
        target: '04a11a367e708c52557930c4e9c1301f4465100d1b1b6d0a62b48d3e32402867',
        minOut: '49000000',
      },
      expectedSlippageBps: 80,
      rationale: 'De-risk leg.',
    };
    expect(validate('allocationProposal', p).valid).toBe(true);
  });

  it('rejects a non-decimal amount string', () => {
    const res = validate('rebalanceAction', {
      kind: 'Stake',
      asset: 'CSPR',
      amount: '1.5e9',
      target: 'abc',
    });
    expect(res.valid).toBe(false);
  });

  it('accepts a full Decision with transcript', () => {
    const d: Decision = {
      consensus: true,
      source: 'llm',
      regime: 'Stressed',
      finalAction: {
        kind: 'SwapToStable',
        asset: 'sCSPR',
        amount: '500000000000',
        target: '04a11a367e708c52557930c4e9c1301f4465100d1b1b6d0a62b48d3e32402867',
      },
      transcript: [
        {
          round: 1,
          role: 'Treasury',
          kind: 'propose',
          proposal: {
            targetBps: { scspr: 2000, csprusd: 8000, csprBuffer: 0 },
            action: {
              kind: 'SwapToStable',
              asset: 'sCSPR',
              amount: '500000000000',
              target: '04a11a367e708c52557930c4e9c1301f4465100d1b1b6d0a62b48d3e32402867',
            },
            expectedSlippageBps: 80,
            rationale: 'Rotate to stable.',
          },
          rationale: 'Stressed regime.',
        },
        { round: 1, role: 'Risk', kind: 'approve', rationale: 'Within caps and bounds.' },
      ],
      snapshotHash: 'a'.repeat(64),
    };
    expect(validate('decision', d).valid).toBe(true);
  });

  it('accepts a MarketSnapshot without the optional premiumSignal', () => {
    const s: MarketSnapshot = {
      timestamp: 1_700_000_000_000,
      csprUsdTwap: 0.0123,
      csprUsdSpot: 0.0125,
      twapSpotDivergenceBps: 162,
      volatility: { window: '24h', annualizedPct: 84.2 },
      liquidity: { csprUsdPool: { depthUsd: 50000 }, priceImpactCurve: [] },
      vault: { cspr: '100000000000', scspr: '500000000000', csprusd: '40000000' },
      provenance: [{ field: 'csprUsdTwap', label: 'VERIFIED', source: 'styks' }],
    };
    expect(validate('marketSnapshot', s).valid).toBe(true);
  });
});
