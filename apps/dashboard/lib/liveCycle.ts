/**
 * Adapter from the runner's transport `CycleView` (`@sentinel/shared`) to the dashboard's `Cycle`
 * view model. The two are nearly identical — `CycleView` is the on-the-wire shape the autonomous
 * runner emits; this fills the UI-only `scenario` tag (derived from the regime, since a live cycle
 * isn't an injected scenario) and marks the cycle `live` so the UI can style/verify it as real.
 */
import type { CycleView, Regime } from '@sentinel/shared';
import type { Cycle, ScenarioKind } from './types';

const REGIME_SCENARIO: Record<Regime, ScenarioKind> = {
  Stressed: 'shock',
  Elevated: 'crunch',
  Calm: 'calm',
};

export function cycleViewToCycle(v: CycleView): Cycle {
  return {
    id: v.id,
    scenario: REGIME_SCENARIO[v.regime],
    startedAt: v.startedAt,
    regime: v.regime,
    snapshot: v.snapshot,
    perceptionHash: v.perceptionHash,
    riskVerdict: v.riskVerdict,
    proposal: v.proposal,
    decision: v.decision,
    decisionHash: v.decisionHash,
    preAllocBps: v.preAllocBps,
    postAllocBps: v.postAllocBps,
    targetBps: v.targetBps,
    notionalUsd: v.notionalUsd,
    deployHash: v.deployHash,
    receipt: v.receipt,
    x402Spend: v.x402Spend,
    live: true,
  };
}
