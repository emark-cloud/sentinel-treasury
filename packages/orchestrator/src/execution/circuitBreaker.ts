/**
 * Circuit breaker (spec §8.5, §11) — trips the owner kill switch (`pause(true)`) when the agent
 * starts misbehaving: N consecutive reverted actions, or a single anomalous USD loss. It is a
 * pure state machine; the caller wires `shouldPause` to a `buildPauseTx` submission (owner key).
 *
 * A successful or skipped action resets the consecutive-revert counter. Once tripped, it stays
 * tripped until `reset()` (owner intervention) — it won't keep re-issuing pause transactions.
 */
import type { ActionResult } from '@sentinel/shared';

export interface CircuitBreakerConfig {
  /** Consecutive `Reverted` actions that trip the breaker. */
  maxConsecutiveReverts: number;
  /** A single-cycle realized USD loss above this trips the breaker (optional). */
  maxLossUsd?: number;
}

export interface CircuitBreakerOutcome {
  /** True only on the transition into tripped — submit `pause(true)` exactly once. */
  shouldPause: boolean;
  tripped: boolean;
  reason?: string;
  consecutiveReverts: number;
}

export class CircuitBreaker {
  private consecutiveReverts = 0;
  private tripped = false;

  constructor(private readonly cfg: CircuitBreakerConfig) {}

  /** Feed one cycle's outcome; returns whether the breaker should trip now. */
  record(result: ActionResult | 'Pending', lossUsd = 0): CircuitBreakerOutcome {
    if (result === 'Reverted') {
      this.consecutiveReverts += 1;
    } else if (result === 'Success' || result === 'Skipped') {
      this.consecutiveReverts = 0;
    }
    // 'Pending' is inconclusive — leave the counter untouched.

    let reason: string | undefined;
    if (this.consecutiveReverts >= this.cfg.maxConsecutiveReverts) {
      reason = `${this.consecutiveReverts} consecutive reverted actions`;
    } else if (this.cfg.maxLossUsd !== undefined && lossUsd > this.cfg.maxLossUsd) {
      reason = `anomalous loss $${lossUsd.toFixed(2)} > $${this.cfg.maxLossUsd.toFixed(2)} cap`;
    }

    const wasTripped = this.tripped;
    if (reason) this.tripped = true;

    return {
      shouldPause: this.tripped && !wasTripped,
      tripped: this.tripped,
      ...(reason ? { reason } : {}),
      consecutiveReverts: this.consecutiveReverts,
    };
  }

  /** Owner reset after intervention. */
  reset(): void {
    this.consecutiveReverts = 0;
    this.tripped = false;
  }

  get isTripped(): boolean {
    return this.tripped;
  }
}
