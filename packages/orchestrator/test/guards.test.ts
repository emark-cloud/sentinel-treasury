import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/execution/circuitBreaker.js';
import { evaluateOracle } from '../src/execution/oracleGuard.js';

describe('CircuitBreaker', () => {
  it('trips after N consecutive reverts and pauses exactly once', () => {
    const cb = new CircuitBreaker({ maxConsecutiveReverts: 3 });
    expect(cb.record('Reverted').shouldPause).toBe(false);
    expect(cb.record('Reverted').shouldPause).toBe(false);
    const third = cb.record('Reverted');
    expect(third.shouldPause).toBe(true);
    expect(third.tripped).toBe(true);
    // Stays tripped but won't re-issue a pause.
    expect(cb.record('Reverted').shouldPause).toBe(false);
  });

  it('a success resets the consecutive-revert counter', () => {
    const cb = new CircuitBreaker({ maxConsecutiveReverts: 2 });
    cb.record('Reverted');
    cb.record('Success');
    expect(cb.record('Reverted').tripped).toBe(false);
    expect(cb.record('Reverted').shouldPause).toBe(true);
  });

  it('Pending outcomes are inconclusive and do not change the counter', () => {
    const cb = new CircuitBreaker({ maxConsecutiveReverts: 2 });
    cb.record('Reverted');
    cb.record('Pending');
    expect(cb.record('Reverted').shouldPause).toBe(true);
  });

  it('trips on an anomalous single-cycle loss', () => {
    const cb = new CircuitBreaker({ maxConsecutiveReverts: 99, maxLossUsd: 100 });
    const out = cb.record('Success', 250);
    expect(out.shouldPause).toBe(true);
    expect(out.reason).toContain('anomalous loss');
  });

  it('reset() clears the tripped state', () => {
    const cb = new CircuitBreaker({ maxConsecutiveReverts: 1 });
    cb.record('Reverted');
    expect(cb.isTripped).toBe(true);
    cb.reset();
    expect(cb.isTripped).toBe(false);
  });
});

describe('evaluateOracle', () => {
  const cfg = { maxHeartbeatAgeSec: 5400, maxDivergenceBps: 500 };

  it('passes a fresh feed within the divergence ceiling', () => {
    const r = evaluateOracle({ divergenceBps: 120, heartbeatSec: 1000, nowSec: 2000 }, cfg);
    expect(r.ok).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it('rejects a stale heartbeat', () => {
    const r = evaluateOracle({ divergenceBps: 10, heartbeatSec: 1000, nowSec: 1000 + 6000 }, cfg);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('stale');
  });

  it('rejects an unreadable heartbeat', () => {
    const r = evaluateOracle({ divergenceBps: 10, heartbeatSec: null, nowSec: 2000 }, cfg);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('unreadable');
  });

  it('rejects excessive twap/spot divergence', () => {
    const r = evaluateOracle({ divergenceBps: 900, heartbeatSec: 1900, nowSec: 2000 }, cfg);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('divergence');
  });
});
