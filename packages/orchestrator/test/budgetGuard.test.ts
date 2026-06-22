import { describe, it, expect } from 'vitest';
import { BudgetGuard } from '../src/x402/budgetGuard.js';

const t0 = 1_700_000_000_000;
const amt = 1_000_000_000n; // 1 CSPR

describe('BudgetGuard', () => {
  it('allows a fresh pull within budget', () => {
    const g = new BudgetGuard();
    g.beginIteration();
    expect(g.evaluate('req-1', amt, t0).kind).toBe('allow');
  });

  it('enforces one paid pull per iteration', () => {
    const g = new BudgetGuard();
    g.beginIteration();
    expect(g.evaluate('req-1', amt, t0).kind).toBe('allow');
    g.recordPayment(
      { requestKey: 'req-1', amountMotes: amt, settleTx: 'tx1', signal: { riskIndex: 50 } },
      t0,
    );
    // A different request in the same iteration is denied (already paid this iteration).
    expect(g.evaluate('req-2', amt, t0).kind).toBe('deny-already-paid');
    // Next iteration resets the per-iteration gate.
    g.beginIteration();
    expect(g.evaluate('req-2', amt, t0 + 1).kind).toBe('allow');
  });

  it('suppresses duplicate identical requests within the cache window', () => {
    const g = new BudgetGuard();
    g.beginIteration();
    g.evaluate('req-1', amt, t0);
    g.recordPayment(
      { requestKey: 'req-1', amountMotes: amt, settleTx: 'tx1', signal: { riskIndex: 42 } },
      t0,
    );
    g.beginIteration();
    const d = g.evaluate('req-1', amt, t0 + 1000);
    expect(d.kind).toBe('suppress-duplicate');
    expect(d.cached?.settleTx).toBe('tx1');
    expect((d.cached?.signal as { riskIndex: number }).riskIndex).toBe(42);
  });

  it('expires the duplicate cache after the window', () => {
    const g = new BudgetGuard({ duplicateWindowMs: 1000 });
    g.beginIteration();
    g.recordPayment({ requestKey: 'req-1', amountMotes: amt, settleTx: 'tx1', signal: {} }, t0);
    g.beginIteration();
    expect(g.evaluate('req-1', amt, t0 + 2000).kind).toBe('allow');
  });

  it('enforces the hourly cap across iterations', () => {
    const g = new BudgetGuard({ hourlyCapMotes: 2_500_000_000n }); // 2.5 CSPR
    g.beginIteration();
    g.recordPayment({ requestKey: 'a', amountMotes: amt, settleTx: 'tx', signal: {} }, t0);
    g.beginIteration();
    g.recordPayment({ requestKey: 'b', amountMotes: amt, settleTx: 'tx', signal: {} }, t0 + 10);
    g.beginIteration();
    // 2 CSPR spent; a third 1 CSPR pull would hit 3 > 2.5 cap.
    expect(g.evaluate('c', amt, t0 + 20).kind).toBe('deny-hourly-cap');
  });

  it('rolls the spend window forward', () => {
    const g = new BudgetGuard({ hourlyCapMotes: 1_500_000_000n, windowMs: 1000 });
    g.beginIteration();
    g.recordPayment({ requestKey: 'a', amountMotes: amt, settleTx: 'tx', signal: {} }, t0);
    g.beginIteration();
    // Same window → would exceed.
    expect(g.evaluate('b', amt, t0 + 500).kind).toBe('deny-hourly-cap');
    // After the window the old spend drops out.
    expect(g.spentInWindow(t0 + 2000)).toBe(0n);
    expect(g.evaluate('b', amt, t0 + 2000).kind).toBe('allow');
  });

  it('triggers the no-progress backstop after N unchanged paid pulls', () => {
    const g = new BudgetGuard({ noProgressLimit: 2 });
    // Two consecutive paid pulls that did not change the decision.
    g.recordProgress(true, false);
    g.recordProgress(true, false);
    g.beginIteration();
    expect(g.evaluate('a', amt, t0).kind).toBe('deny-no-progress');
  });

  it('resets the no-progress counter when the decision changes', () => {
    const g = new BudgetGuard({ noProgressLimit: 2 });
    g.recordProgress(true, false);
    g.recordProgress(true, true); // changed → reset
    g.recordProgress(true, false);
    g.beginIteration();
    expect(g.evaluate('a', amt, t0).kind).toBe('allow');
  });
});
