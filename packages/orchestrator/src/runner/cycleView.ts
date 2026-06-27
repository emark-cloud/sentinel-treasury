/**
 * Map a completed loop {@link CycleResult} into the transport-ready {@link CycleView} the dashboard
 * renders. The loop returns hashes + the decision/execution outcome but not the snapshot object
 * (only its hash), so the runner re-reads the snapshot from the artifact store by `perceptionHash`
 * — the same artifact whose hash is committed on-chain, so the dashboard's verify button still
 * recomputes a genuine hash.
 *
 * Only cycles that produced a decision (stage `acted`, including NoOp) map to a full view; guarded /
 * paused cycles carry no decision and are surfaced through the runner status, not the cycle feed.
 */
import type {
  AllocationProposal,
  CycleView,
  MarketSnapshot,
  Receipt,
  Regime,
} from '@sentinel/shared';
import type { CycleResult } from '../loop.js';

/** Regime → display target weights (bps) when no proposal target is available. */
const REGIME_TARGET: Record<Regime, { scspr: number; csprusd: number }> = {
  Calm: { scspr: 6000, csprusd: 4000 },
  Elevated: { scspr: 4000, csprusd: 6000 },
  Stressed: { scspr: 2000, csprusd: 8000 },
};

export interface ToCycleViewInput {
  result: CycleResult;
  snapshot: MarketSnapshot;
  /** Agent identity recorded in the receipt (public-key hex or label). */
  agent: string;
  /** Cycle start (unix ms). */
  startedAt: number;
  source?: 'live' | 'demo';
  /** The cycle's x402 paid pull, if one happened. */
  x402Spend?: { amountCspr: number; settleTx: string };
}

/** The last Treasury proposal in the transcript (proposer–critic), or null if none was recorded. */
function proposalFromTranscript(result: CycleResult): AllocationProposal | null {
  const turns = result.decision?.decision.transcript ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const p = turns[i]?.proposal;
    if (p) return p;
  }
  return null;
}

/**
 * Build a {@link CycleView} from an `acted`-stage result. Returns null when the result carries no
 * decision (guarded / paused), which has nothing to render in the center column.
 */
export function toCycleView(input: ToCycleViewInput): CycleView | null {
  const { result, snapshot, agent, startedAt } = input;
  const decision = result.decision;
  if (!decision) return null;

  const sized = decision.sized;
  const regime = decision.decision.regime;
  const action = sized.action;
  const notionalUsd = Math.round(sized.sizeUsd * 1e6).toString();
  const deployHash = result.execution?.deployHash ?? '';
  const settled = result.execution?.result ?? 'Pending';

  const fromTranscript = proposalFromTranscript(result);
  const target = fromTranscript
    ? { scspr: fromTranscript.targetBps.scspr, csprusd: fromTranscript.targetBps.csprusd }
    : REGIME_TARGET[regime];

  const proposal: AllocationProposal = fromTranscript ?? {
    targetBps: { scspr: target.scspr, csprusd: target.csprusd, csprBuffer: 0 },
    action,
    expectedSlippageBps: sized.expectedSlippageBps,
    rationale: sized.reason,
  };

  const receipt: Receipt = {
    actionId: result.cycleId,
    timestamp: String(startedAt),
    agent,
    account: result.account ?? '',
    actionKind: action.kind,
    regime,
    perceptionHash: result.perceptionHash ?? '',
    decisionHash: decision.decisionHash,
    preAllocBps: sized.preAllocBps,
    postAllocBps: sized.postAllocBps,
    amount: action.amount,
    notionalUsd,
    target: action.target,
    deployHash,
    result: settled === 'Pending' ? 'Skipped' : settled,
    csprUsdTwap: Math.round(snapshot.csprUsdTwap * 1e5).toString(), // Styks 5-decimal scale (D-012)
  };

  return {
    id: result.cycleId,
    source: input.source ?? 'live',
    account: result.account ?? '',
    startedAt,
    stage: result.stage,
    regime,
    snapshot,
    perceptionHash: result.perceptionHash ?? '',
    riskVerdict: decision.verdict,
    proposal,
    decision: decision.decision,
    decisionHash: decision.decisionHash,
    preAllocBps: sized.preAllocBps,
    postAllocBps: sized.postAllocBps,
    targetBps: target,
    notionalUsd,
    deployHash,
    result: settled,
    ...(result.reason ? { reason: result.reason } : {}),
    receipt,
    x402Spend: input.x402Spend ?? { amountCspr: 0, settleTx: '' },
  };
}
