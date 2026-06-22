/**
 * x402 budget guard (spec §5.2, §11 "x402 budget guard") — the discipline that keeps the one
 * paid premium pull bounded and non-abusive:
 *
 *  1. **One paid pull per loop iteration** — at most one settlement per cycle.
 *  2. **Hourly CSPR cap** — cumulative settled amount in a rolling 1h window is bounded.
 *  3. **Duplicate-request suppression** — an identical request within the cache window reuses
 *     the prior result instead of paying again.
 *  4. **No-progress backstop** — if paid pulls stop changing the decision for N consecutive
 *     iterations, stop paying (the signal isn't earning its cost).
 *
 * Pure, deterministic, time-injected (`now` is passed in) so it is fully unit-testable and has
 * no hidden clock. The guard decides *whether* to pay; the x402 client performs the payment and
 * reports back via `recordPayment` / `recordProgress`.
 */

export interface BudgetGuardConfig {
  /** Rolling spend window in ms (default 1h). */
  windowMs: number;
  /** Max cumulative settled amount (base units, e.g. WCSPR motes) per window. */
  hourlyCapMotes: bigint;
  /** Reuse a cached result for an identical request key within this window (ms). */
  duplicateWindowMs: number;
  /** Stop paying after this many consecutive no-progress paid pulls. */
  noProgressLimit: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetGuardConfig = {
  windowMs: 60 * 60 * 1000,
  hourlyCapMotes: 50_000_000_000n, // 50 CSPR/hr cap (motes) — conservative demo budget
  duplicateWindowMs: 5 * 60 * 1000,
  noProgressLimit: 3,
};

export type BudgetDecisionKind =
  | 'allow'
  | 'suppress-duplicate'
  | 'deny-already-paid'
  | 'deny-hourly-cap'
  | 'deny-no-progress';

export interface CachedPull {
  requestKey: string;
  settleTx: string;
  amountMotes: string;
  at: number;
  /** The premium signal payload returned for this request. */
  signal: unknown;
}

export interface BudgetDecision {
  kind: BudgetDecisionKind;
  reason: string;
  /** Present for `suppress-duplicate`: the cached result to reuse without paying. */
  cached?: CachedPull;
}

interface SpendEntry {
  at: number;
  amount: bigint;
}

export class BudgetGuard {
  private readonly cfg: BudgetGuardConfig;
  private spends: SpendEntry[] = [];
  private readonly cache = new Map<string, CachedPull>();
  private paidThisIteration = false;
  private consecutiveNoProgress = 0;

  constructor(config: Partial<BudgetGuardConfig> = {}) {
    this.cfg = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  /** Reset per-iteration state. Call once at the start of each loop cycle. */
  beginIteration(): void {
    this.paidThisIteration = false;
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.cfg.windowMs;
    this.spends = this.spends.filter((s) => s.at >= cutoff);
  }

  /** Total settled in the rolling window as of `now`. */
  spentInWindow(now: number): bigint {
    this.pruneWindow(now);
    return this.spends.reduce((acc, s) => acc + s.amount, 0n);
  }

  /**
   * Decide whether the guard permits a paid pull for `requestKey` of `amountMotes` at `now`.
   * Order: no-progress backstop → duplicate cache → one-per-iteration → hourly cap → allow.
   */
  evaluate(requestKey: string, amountMotes: bigint, now: number): BudgetDecision {
    if (this.consecutiveNoProgress >= this.cfg.noProgressLimit) {
      return {
        kind: 'deny-no-progress',
        reason: `paid pulls unchanged for ${this.consecutiveNoProgress} iterations (≥${this.cfg.noProgressLimit})`,
      };
    }

    const cached = this.cache.get(requestKey);
    if (cached && now - cached.at <= this.cfg.duplicateWindowMs) {
      return {
        kind: 'suppress-duplicate',
        reason: `identical request within ${this.cfg.duplicateWindowMs}ms — reusing settle ${cached.settleTx}`,
        cached,
      };
    }

    if (this.paidThisIteration) {
      return { kind: 'deny-already-paid', reason: 'one paid pull per iteration already used' };
    }

    const projected = this.spentInWindow(now) + amountMotes;
    if (projected > this.cfg.hourlyCapMotes) {
      return {
        kind: 'deny-hourly-cap',
        reason: `would exceed hourly cap (${projected} > ${this.cfg.hourlyCapMotes} motes)`,
      };
    }

    return { kind: 'allow', reason: 'within budget' };
  }

  /** Record a completed settlement; updates the rolling spend, per-iteration flag, and cache. */
  recordPayment(
    pull: { requestKey: string; amountMotes: bigint; settleTx: string; signal: unknown },
    now: number,
  ): void {
    this.spends.push({ at: now, amount: pull.amountMotes });
    this.paidThisIteration = true;
    this.cache.set(pull.requestKey, {
      requestKey: pull.requestKey,
      settleTx: pull.settleTx,
      amountMotes: pull.amountMotes.toString(),
      at: now,
      signal: pull.signal,
    });
  }

  /**
   * Feed the no-progress backstop: `changed` = did this cycle's decision differ from the prior
   * cycle's? A paid pull that doesn't move the decision increments the counter; any change (or a
   * cycle that didn't pay) resets it.
   */
  recordProgress(paid: boolean, changed: boolean): void {
    if (!paid) {
      this.consecutiveNoProgress = 0;
      return;
    }
    if (changed) this.consecutiveNoProgress = 0;
    else this.consecutiveNoProgress += 1;
  }
}
