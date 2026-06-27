/**
 * `CycleView` — the serialized, transport-ready view of one perceive→decide→act→prove cycle.
 *
 * The autonomous runner (`packages/orchestrator/src/runner`) emits one of these per account per
 * cycle; the dashboard consumes them (over the runner's `/cycles` + `/cycles/stream` SSE feed) and
 * animates the center column from real activity instead of a client-side scenario. It carries every
 * field the dashboard's cycle view model needs, plus provenance: `source` distinguishes a real
 * on-chain cycle from a demo injection, and `result`/`stage`/`reason` capture how the cycle ended
 * (acted, guard-rejected, NoOp, paused).
 *
 * The `receipt` here is the *rich* view of the action; the verifiable backbone is the on-chain
 * `Receipt` read independently from the AuditLog (the two are cross-checkable by hash equality).
 */
import type {
  AllocationBps,
  ActionResult,
  Receipt,
  Regime,
} from './onchain.js';
import type { MarketSnapshot } from './market.js';
import type { AllocationProposal, Decision, RiskVerdict } from './decision.js';

export interface CycleView {
  /** Cycle id (the runner suffixes the base id with the account short-hash). */
  id: string;
  /** Real on-chain cycle vs a labelled demo injection (spec §15.3 honesty seam). */
  source: 'live' | 'demo';
  /** Depositor account-hash (hex) this cycle acted for. */
  account: string;
  /** Cycle start (unix ms). */
  startedAt: number;
  /** How far the cycle progressed (mirrors the loop's `CycleResult.stage`). */
  stage: 'paused' | 'perceived' | 'guarded' | 'decided' | 'acted';
  regime: Regime;
  snapshot: MarketSnapshot;
  perceptionHash: string;
  riskVerdict: RiskVerdict;
  /** Treasury's proposal (from the deliberation transcript, or derived from the sized action). */
  proposal: AllocationProposal;
  decision: Decision;
  decisionHash: string;
  preAllocBps: AllocationBps;
  postAllocBps: AllocationBps;
  targetBps: { scspr: number; csprusd: number };
  /** Action notional in micro-USD (1e6 = $1). */
  notionalUsd: string;
  /** Submitted transaction hash (empty for NoOp / guarded / paused cycles). */
  deployHash: string;
  /** Final on-chain result; `Pending` when submitted but finality not yet observed. */
  result: ActionResult | 'Pending';
  /** Why the cycle did not act (NoOp / oracle reject / pause), when applicable. */
  reason?: string;
  receipt: Receipt;
  /** The single x402 paid premium pull for this cycle (0/empty when none happened). */
  x402Spend: { amountCspr: number; settleTx: string };
}

/** Runner liveness + scheduling status (the `/status` endpoint; drives the dashboard loop header). */
export interface RunnerStatus {
  running: boolean;
  paused: boolean;
  breakerTripped: boolean;
  /** Unix ms of the last completed cycle batch, or null before the first run. */
  lastRunAt: number | null;
  /** Unix ms the next scheduled batch is due, or null when not scheduled. */
  nextRunAt: number | null;
  /** Configured cadence between batches (ms). */
  intervalMs: number;
  /** Distinct depositor accounts the agent is managing. */
  accountCount: number;
}
