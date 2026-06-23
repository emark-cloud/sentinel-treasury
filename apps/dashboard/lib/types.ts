/** Dashboard view models — the loop state the panels render. */
import type {
  AllocationBps,
  AllocationProposal,
  Decision,
  MarketSnapshot,
  Receipt,
  Regime,
  RiskVerdict,
} from '@sentinel/shared';

export type LoopStage = 'idle' | 'perceive' | 'decide' | 'act' | 'prove';
export const LOOP_STAGES: Exclude<LoopStage, 'idle'>[] = ['perceive', 'decide', 'act', 'prove'];

export type ExecStatus = 'idle' | 'building' | 'signing' | 'submitted' | 'finalized' | 'reverted';

export type ScenarioKind = 'shock' | 'calm';

/** A fully-resolved cycle. The loop controller reveals it stage by stage. */
export interface Cycle {
  id: string;
  scenario: ScenarioKind;
  startedAt: number;
  regime: Regime;
  snapshot: MarketSnapshot;
  perceptionHash: string;
  riskVerdict: RiskVerdict;
  proposal: AllocationProposal;
  decision: Decision;
  decisionHash: string;
  preAllocBps: AllocationBps;
  postAllocBps: AllocationBps;
  targetBps: { scspr: number; csprusd: number };
  notionalUsd: string; // USD micros
  deployHash: string;
  receipt: Receipt;
  /** One x402 paid premium pull happened this cycle. */
  x402Spend: { amountCspr: number; settleTx: string };
}

/** x402 budget meter state (design.md §5.8). */
export interface X402State {
  paidPulls: number;
  csprSpent: number;
  lastSettleTx: string | null;
}
