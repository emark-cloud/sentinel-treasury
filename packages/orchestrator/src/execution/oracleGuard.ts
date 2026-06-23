/**
 * Oracle-staleness guard (spec §8, §11) — a pure pre-flight check that rejects a cycle when the
 * price signal can't be trusted: the Styks heartbeat is stale, or the TWAP/spot divergence is too
 * wide (a sign of a thin/dislocated market or a manipulated spot). Rejecting here means the cycle
 * NoOps rather than acting on a bad price; the on-chain USD caps remain the last line of defence.
 */
export interface OracleGuardConfig {
  /** Max age of the Styks heartbeat before the feed is considered stale (seconds). */
  maxHeartbeatAgeSec: number;
  /** Max acceptable |spot − twap| / twap before the cycle is rejected (bps). */
  maxDivergenceBps: number;
}

export interface OracleGuardInput {
  /** |spot − twap| / twap from the snapshot (bps). */
  divergenceBps: number;
  /** Last Styks heartbeat (unix seconds), or `null` if unknown/unreadable. */
  heartbeatSec: number | null;
  /** Current time (unix seconds). */
  nowSec: number;
}

export interface OracleGuardResult {
  ok: boolean;
  reasons: string[];
}

/** Evaluate the oracle guard; `ok:false` with reasons means the cycle should NoOp. */
export function evaluateOracle(input: OracleGuardInput, cfg: OracleGuardConfig): OracleGuardResult {
  const reasons: string[] = [];

  if (input.heartbeatSec === null) {
    reasons.push('styks heartbeat unreadable — cannot confirm price freshness');
  } else {
    const ageSec = input.nowSec - input.heartbeatSec;
    if (ageSec > cfg.maxHeartbeatAgeSec) {
      reasons.push(`styks heartbeat stale: ${ageSec}s old > ${cfg.maxHeartbeatAgeSec}s threshold`);
    }
  }

  if (input.divergenceBps > cfg.maxDivergenceBps) {
    reasons.push(
      `twap/spot divergence ${input.divergenceBps}bps > ${cfg.maxDivergenceBps}bps ceiling`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}
