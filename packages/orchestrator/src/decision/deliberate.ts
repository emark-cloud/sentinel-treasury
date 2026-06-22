/**
 * Deliberation protocol + Decision engine (spec §6.2, §7) — the visible "debate" and the step that
 * turns it into a hashed, verifiable `Decision`.
 *
 * Proposer–critic loop (default R=2): Treasury proposes a target allocation → the Risk critic runs
 * its deterministic veto checks (`critiqueProposal`) → APPROVE ends the debate; REJECT feeds the
 * reasons back for one revise round. No approval within R rounds → deterministic fallback, flagged
 * `consensus:false, source:'fallback'`. Every turn is captured verbatim in the transcript.
 *
 * The agreed (or fallback) target is then **clamped** to the legal envelope and sized into a single
 * concrete on-chain action (`computeFinalAction`) — so the `Decision.finalAction` amount is always
 * derived deterministically, never lifted free-form from the LLM. The `Decision` is validated,
 * blake2b-hashed into `decisionHash`, and retained in the artifact store (spec §9).
 */
import { hashCanonical, validate } from '@sentinel/shared';
import type {
  MarketSnapshot,
  Decision,
  DeliberationTurn,
  AllocationProposal,
  RiskVerdict,
  Regime,
} from '@sentinel/shared';
import type { RiskAgent } from '../agents/risk.js';
import type { TreasuryAgent } from '../agents/treasury.js';
import type { ArtifactStore } from '../store/artifactStore.js';
import { clampTargetBps, critiqueProposal, fallbackAllocation } from './ruleEngine.js';
import { valuate } from './normalize.js';
import { computeFinalAction } from './sizing.js';
import type { SizedDecision } from './sizing.js';
import type { TargetBps, DecisionInputs, DecisionPolicy, UsdValuation } from './types.js';

export interface DeliberationOutcome {
  verdict: RiskVerdict;
  regime: Regime;
  /** The agreed target (consensus) or the regime fallback allocation. */
  targetBps: TargetBps;
  transcript: DeliberationTurn[];
  consensus: boolean;
  source: 'llm' | 'fallback';
}

export interface DeliberatorConfig {
  /** Max proposer–critic rounds (spec §6.2 default R=2). */
  maxRounds?: number;
}

/** Runs the proposer–critic debate and yields a target allocation + verbatim transcript. */
export class Deliberator {
  private readonly maxRounds: number;
  constructor(
    private readonly risk: RiskAgent,
    private readonly treasury: TreasuryAgent,
    private readonly policy: DecisionPolicy,
    cfg?: DeliberatorConfig,
  ) {
    this.maxRounds = cfg?.maxRounds ?? 2;
  }

  async deliberate(snapshot: MarketSnapshot): Promise<DeliberationOutcome> {
    const { verdict, source: riskSource } = await this.risk.assess(snapshot);
    const transcript: DeliberationTurn[] = [];

    let reviseReasons: string[] | undefined;
    let agreed: AllocationProposal | null = null;
    let llmHealthy = riskSource === 'llm';

    for (let round = 1; round <= this.maxRounds; round++) {
      const { proposal, source: tSource } = await this.treasury.propose({
        snapshot,
        verdict,
        round,
        ...(reviseReasons ? { reviseReasons } : {}),
      });
      if (tSource !== 'llm') llmHealthy = false;

      transcript.push({
        round,
        role: 'Treasury',
        kind: round === 1 ? 'propose' : 'revise',
        proposal,
        rationale: proposal.rationale,
      });

      const critique = critiqueProposal(proposal, verdict, this.policy);
      if (critique.approved) {
        transcript.push({
          round,
          role: 'Risk',
          kind: 'approve',
          rationale:
            'Proposal sits within the regime band, the policy bounds, the Risk hard limits, and the slippage ceiling.',
        });
        agreed = proposal;
        break;
      }

      transcript.push({
        round,
        role: 'Risk',
        kind: 'reject',
        reasons: critique.reasons,
        rationale: 'Proposal breaches one or more guardrails; revise required.',
      });
      reviseReasons = critique.reasons;
    }

    if (agreed) {
      return {
        verdict,
        regime: verdict.regime,
        targetBps: agreed.targetBps,
        transcript,
        consensus: true,
        // Consensus on an LLM proposal with a healthy LLM Risk turn ⇒ 'llm'; an approved
        // deterministic fallback proposal is still the rule engine ⇒ 'fallback'.
        source: llmHealthy ? 'llm' : 'fallback',
      };
    }

    // No consensus within R rounds → deterministic fallback (spec §6.2 step 5).
    return {
      verdict,
      regime: verdict.regime,
      targetBps: fallbackAllocation(verdict.regime),
      transcript,
      consensus: false,
      source: 'fallback',
    };
  }
}

export interface DecisionResult {
  decision: Decision;
  /** Hex blake2b-256 of the `Decision` == on-chain `decision_hash`. */
  decisionHash: string;
  verdict: RiskVerdict;
  valuation: UsdValuation;
  /** Sized action + pre/post allocation bps + notional, for the Phase-5 receipt. */
  sized: SizedDecision;
}

/**
 * The Decision engine wires the deliberation, the clamp, the USD sizing, and the proof artifact
 * into a single `decide(...)` call.
 */
export class DecisionEngine {
  constructor(
    private readonly deliberator: Deliberator,
    private readonly store: ArtifactStore,
  ) {}

  async decide(
    cycleId: string,
    snapshot: MarketSnapshot,
    perceptionHash: string,
    inputs: DecisionInputs,
  ): Promise<DecisionResult> {
    const outcome = await this.deliberator.deliberate(snapshot);

    // Defense-in-depth clamp: even the fallback target is re-clamped to the legal envelope.
    const clamped = clampTargetBps(
      outcome.targetBps,
      outcome.regime,
      inputs.policy,
      outcome.verdict.hardLimits,
    );

    const valuation = valuate(
      snapshot.vault,
      snapshot.csprUsdTwap,
      inputs.exchangeRate,
      inputs.policy.csprBufferCspr,
      inputs.decimals,
    );

    const sized = computeFinalAction(
      clamped,
      valuation,
      snapshot.csprUsdTwap,
      snapshot.liquidity.priceImpactCurve,
      inputs,
      outcome.verdict.hardLimits.maxActionUsd,
    );

    const decision: Decision = {
      consensus: outcome.consensus,
      source: outcome.source,
      regime: outcome.regime,
      finalAction: sized.action,
      transcript: outcome.transcript,
      snapshotHash: perceptionHash,
    };

    const result = validate<Decision>('decision', decision);
    if (!result.valid) {
      throw new Error(`DecisionEngine produced an invalid Decision: ${result.errors?.join('; ')}`);
    }

    const decisionHash = hashCanonical(decision);
    const storedHash = await this.store.putDecision(cycleId, decision);
    if (storedHash !== decisionHash) {
      throw new Error(`decision hash mismatch: ${storedHash} != ${decisionHash}`);
    }

    return { decision, decisionHash, verdict: outcome.verdict, valuation, sized };
  }
}
