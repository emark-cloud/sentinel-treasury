/**
 * Agent decision models (spec §6.3) — the structured JSON every agent turn must emit,
 * validated against the schemas in `src/schemas` (parse-validate-retry, then fallback).
 *
 * `Decision` is canonicalized and blake2b-256 hashed into `Receipt.decisionHash`; the
 * full object (including the verbatim `transcript`) is retained off-chain (spec §9).
 */
import type { Regime, ActionKind } from './onchain.js';

/** Risk agent output — classifies the regime and imposes per-cycle hard ceilings. */
export interface RiskVerdict {
  regime: Regime;
  /** 0..100. */
  riskScore: number;
  /** Human-readable drivers, e.g. 'twap-spot divergence 3.1%'. */
  drivers: string[];
  hardLimits: {
    maxScsprBps: number;
    /** USD ceiling for this cycle's single action. */
    maxActionUsd: number;
  };
  rationale: string;
}

/** Asset symbols the agent reasons over (WUSDT stands in for csprUSD on Testnet — D-005). */
export type AgentAsset = 'CSPR' | 'sCSPR' | 'csprUSD';

/** The single concrete step toward target for this cycle. */
export interface RebalanceAction {
  kind: ActionKind;
  asset: AgentAsset;
  /** Base units, decimal string. */
  amount: string;
  /** Whitelisted target contract (package hash hex). */
  target: string;
  /** For swaps: minimum acceptable output, derived from `maxSlippageBps`. */
  minOut?: string;
}

/** Treasury agent output — a target allocation and the concrete action to approach it. */
export interface AllocationProposal {
  /** Sums to 10000. */
  targetBps: {
    scspr: number;
    csprusd: number;
    csprBuffer: number;
  };
  action: RebalanceAction;
  expectedSlippageBps: number;
  rationale: string;
}

/** One turn in the proposer–critic deliberation (spec §6.2), captured verbatim. */
export interface DeliberationTurn {
  round: number;
  role: 'Treasury' | 'Risk';
  /** 'propose' | 'revise' from Treasury; 'approve' | 'reject' from Risk. */
  kind: 'propose' | 'revise' | 'approve' | 'reject';
  /** Treasury turns carry a proposal; Risk turns carry reasons on reject. */
  proposal?: AllocationProposal;
  reasons?: string[];
  rationale: string;
}

/** Final decision for a cycle. `consensus:false` ⇒ `source:'fallback'` (rule engine). */
export interface Decision {
  consensus: boolean;
  source: 'llm' | 'fallback';
  regime: Regime;
  finalAction: RebalanceAction;
  transcript: DeliberationTurn[];
  /** Hex blake2b-256 of the MarketSnapshot this decision was made from. */
  snapshotHash: string;
}
