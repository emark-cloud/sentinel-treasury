import { describe, it, expect } from 'vitest';
import type { PriceImpactSample } from '@sentinel/shared';
import { valuate, baseToUnits } from '../src/decision/normalize.js';
import { impactAt, shrinkToCeiling, computeFinalAction } from '../src/decision/sizing.js';
import type { DecisionInputs, TargetBps } from '../src/decision/types.js';

const targets = { router: 'router-hash', staking: 'staking-hash' };

function inputs(overrides: Partial<DecisionInputs['policy']> = {}): DecisionInputs {
  return {
    exchangeRate: 1.0,
    targets,
    policy: {
      perActionCapUsd: 1000,
      dailyCapUsd: 5000,
      dayRemainingUsd: 5000,
      maxSlippageBps: 100,
      minScsprBps: 0,
      maxScsprBps: 10000,
      csprBufferCspr: 0,
      minTradeUsd: 1,
      ...overrides,
    },
  };
}

describe('baseToUnits', () => {
  it('converts base units with no precision loss on large values', () => {
    expect(baseToUnits('1000000000', 9)).toBe(1);
    expect(baseToUnits('1500000', 6)).toBe(1.5);
    expect(baseToUnits('0', 9)).toBe(0);
  });
});

describe('valuate', () => {
  it('values buckets in USD via twap + exchange rate and computes weights', () => {
    // 1000 CSPR, 600 sCSPR, 400 stable; twap $1, rate 1.0, no buffer.
    const v = valuate(
      { cspr: '1000000000000', scspr: '600000000000', csprusd: '400000000' },
      1.0,
      1.0,
      0,
    );
    expect(v.csprUsd).toBeCloseTo(1000);
    expect(v.scsprUsd).toBeCloseTo(600);
    expect(v.csprusdUsd).toBeCloseTo(400);
    expect(v.totalUsd).toBeCloseTo(2000);
    expect(v.weightsBps.cspr).toBe(5000);
    expect(v.weightsBps.scspr).toBe(3000);
    expect(v.weightsBps.csprusd).toBe(2000);
  });

  it('excludes the CSPR gas buffer from the investable total', () => {
    const v = valuate({ cspr: '1000000000000', scspr: '0', csprusd: '0' }, 1.0, 1.0, 100);
    expect(v.csprUsd).toBeCloseTo(900); // 1000 - 100 buffer
  });

  it('applies the sCSPR exchange-rate premium', () => {
    const v = valuate({ cspr: '0', scspr: '1000000000', csprusd: '0' }, 1.0, 1.05, 0);
    expect(v.scsprUsd).toBeCloseTo(1.05);
  });
});

describe('impactAt / shrinkToCeiling', () => {
  const curve: PriceImpactSample[] = [
    { sizeUsd: 100, bps: 50 },
    { sizeUsd: 200, bps: 150 },
  ];

  it('interpolates from the (0,0) anchor', () => {
    expect(impactAt(curve, 0)).toBe(0);
    expect(impactAt(curve, 50)).toBeCloseTo(25);
    expect(impactAt(curve, 100)).toBeCloseTo(50);
    expect(impactAt(curve, 150)).toBeCloseTo(100);
  });

  it('extrapolates beyond the last sample', () => {
    expect(impactAt(curve, 300)).toBeCloseTo(250); // slope 1 bps/$
  });

  it('keeps the desired size when impact is under the ceiling', () => {
    expect(shrinkToCeiling(curve, 100, 100)).toBe(100);
  });

  it('shrinks to the largest size under the ceiling', () => {
    // ceiling 100 bps ⇒ impact==100 at size 150.
    expect(shrinkToCeiling(curve, 100, 200)).toBeCloseTo(150, 0);
  });

  it('returns 0 when no curve exists for unbounded impact (empty curve = 0 impact)', () => {
    expect(shrinkToCeiling([], 100, 200)).toBe(200); // empty curve ⇒ zero impact ⇒ no shrink
  });
});

describe('computeFinalAction', () => {
  // Vault skewed risk-on: 80% sCSPR / 20% stable, total $1000.
  const valHeavyScspr = valuate(
    { cspr: '0', scspr: '800000000000', csprusd: '200000000' },
    1.0,
    1.0,
    0,
  );

  it('de-risks (SwapToStable, sell sCSPR) when target wants more stable', () => {
    const target: TargetBps = { scspr: 2000, csprusd: 8000, csprBuffer: 0 }; // Stressed
    const d = computeFinalAction(target, valHeavyScspr, 1.0, [], inputs(), 1000);
    expect(d.action.kind).toBe('SwapToStable');
    expect(d.action.asset).toBe('sCSPR');
    expect(d.action.target).toBe('router-hash');
    expect(d.action.minOut).toBeDefined();
    // need stable: target 800 - current 200 = 600, capped by perAction 1000 ⇒ 600.
    expect(d.sizeUsd).toBeCloseTo(600, 0);
    expect(d.postAllocBps.csprusd).toBeGreaterThan(d.preAllocBps.csprusd);
  });

  it('caps the de-risk size at the per-action cap', () => {
    const target: TargetBps = { scspr: 2000, csprusd: 8000, csprBuffer: 0 };
    const d = computeFinalAction(
      target,
      valHeavyScspr,
      1.0,
      [],
      inputs({ perActionCapUsd: 100 }),
      1000,
    );
    expect(d.sizeUsd).toBeCloseTo(100, 0);
  });

  it('caps the de-risk size at the Risk hard limit (maxActionUsd)', () => {
    const target: TargetBps = { scspr: 2000, csprusd: 8000, csprBuffer: 0 };
    const d = computeFinalAction(target, valHeavyScspr, 1.0, [], inputs(), 50);
    expect(d.sizeUsd).toBeCloseTo(50, 0);
  });

  it('stakes liquid CSPR when target wants more risk and CSPR is available', () => {
    // 50% CSPR / 50% stable, no sCSPR; target wants 60% sCSPR.
    const val = valuate({ cspr: '500000000000', scspr: '0', csprusd: '500000000' }, 1.0, 1.0, 0);
    const target: TargetBps = { scspr: 6000, csprusd: 4000, csprBuffer: 0 };
    const d = computeFinalAction(target, val, 1.0, [], inputs(), 1000);
    expect(d.action.kind).toBe('Stake');
    expect(d.action.asset).toBe('CSPR');
    expect(d.action.target).toBe('staking-hash');
    expect(d.action.minOut).toBeUndefined();
  });

  it('swaps stable→CSPR (SwapToRisk) when growth is needed but no liquid CSPR', () => {
    const val = valuate({ cspr: '0', scspr: '0', csprusd: '1000000000' }, 1.0, 1.0, 0);
    const target: TargetBps = { scspr: 6000, csprusd: 4000, csprBuffer: 0 };
    const d = computeFinalAction(target, val, 1.0, [], inputs(), 1000);
    expect(d.action.kind).toBe('SwapToRisk');
    expect(d.action.asset).toBe('csprUSD');
    expect(d.action.minOut).toBeDefined();
  });

  it('NoOps when already within tolerance of target', () => {
    const val = valuate({ cspr: '0', scspr: '600000000000', csprusd: '400000000' }, 1.0, 1.0, 0);
    const target: TargetBps = { scspr: 6000, csprusd: 4000, csprBuffer: 0 };
    const d = computeFinalAction(target, val, 1.0, [], inputs(), 1000);
    expect(d.action.kind).toBe('NoOp');
    expect(d.sizeUsd).toBe(0);
  });

  it('NoOps when slippage shrinks the trade below the minimum', () => {
    // A curve so steep that even a $1 trade blows the 1 bps ceiling.
    const steep: PriceImpactSample[] = [{ sizeUsd: 1, bps: 500 }];
    const target: TargetBps = { scspr: 2000, csprusd: 8000, csprBuffer: 0 };
    const d = computeFinalAction(
      target,
      valHeavyScspr,
      1.0,
      steep,
      inputs({ maxSlippageBps: 1 }),
      1000,
    );
    expect(d.action.kind).toBe('NoOp');
    expect(d.reason).toContain('slippage');
  });

  it('derives minOut from the slippage ceiling for SwapToStable', () => {
    const target: TargetBps = { scspr: 2000, csprusd: 8000, csprBuffer: 0 };
    const d = computeFinalAction(
      target,
      valHeavyScspr,
      1.0,
      [],
      inputs({ maxSlippageBps: 100 }),
      1000,
    );
    // sizeUsd 600 → stable out base (6 decimals) ~600e6; minOut = 99% of that.
    const expected = Math.floor(600 * 1e6 * 0.99);
    expect(Number(d.action.minOut)).toBeCloseTo(expected, -3);
  });
});
