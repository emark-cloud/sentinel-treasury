/**
 * SentinelLoop (spec §3.1) — the top-level perceive → decide → act → prove controller that ties
 * every layer together into one bounded cycle. Nothing below it is new behaviour: it composes the
 * Phase 3–5 components through their existing seams, in the order the spec mandates, with the
 * guardrails wired in the right places.
 *
 *   PERCEIVE  DataService.collect → Scout.perceive  → hashed MarketSnapshot (perception_hash)
 *   GUARD     oracle-staleness check                → NoOp if the price can't be trusted
 *   DECIDE    DecisionEngine.decide                 → deliberation → clamp → sized action (decision_hash)
 *   ACT       ExecutionService.execute              → signed execute_rebalance, finality, deploy_hash
 *   PROVE     (receipt written on-chain by the vault, atomically — read+verified by the proof layer)
 *   GUARD     CircuitBreaker.record                 → owner pause(true) on repeated reverts / loss
 *
 * Pause is honoured below the agent's reach (the on-chain kill switch), but the loop also refuses to
 * act locally when `paused` so a tripped breaker or an owner pause stops new cycles immediately.
 *
 * The same controller runs against live Testnet sources or the §15.3 scenario harness — only the
 * injected `PerceptionSources` (and an optional injected premium pull) differ. Everything from the
 * Scout onward is identical, which is what makes the demo's "downstream is real" claim true.
 */
import type { Regime } from '@sentinel/shared';
import { DataService } from './data/dataService.js';
import type { PerceptionSources } from './data/dataService.js';
import { exchangeRateToFloat } from './data/onchainReader.js';
import type { Scout } from './agents/scout.js';
import type { VolatilityEstimate } from './agents/scout.js';
import type { PremiumPullResult } from './x402/client.js';
import type { DecisionEngine } from './decision/deliberate.js';
import type { DecisionResult } from './decision/deliberate.js';
import type { DecisionInputs } from './decision/types.js';
import type { ExecutionService } from './execution/executionService.js';
import type { ExecutionOutcome } from './execution/executionService.js';
import { evaluateOracle } from './execution/oracleGuard.js';
import type { OracleGuardConfig, OracleGuardResult } from './execution/oracleGuard.js';
import type { CircuitBreaker } from './execution/circuitBreaker.js';
import type { CircuitBreakerOutcome } from './execution/circuitBreaker.js';
import type { ArtifactStore } from './store/artifactStore.js';

/** The components the loop drives, each already wired (live or scenario) by the caller. */
export interface SentinelLoopDeps {
  sources: PerceptionSources;
  scout: Scout;
  decisionEngine: DecisionEngine;
  execution: ExecutionService;
  circuitBreaker: CircuitBreaker;
  /** Snapshot/decision artifact store (for `getByHash` verification). */
  store: ArtifactStore;
}

export interface SentinelLoopConfig {
  /**
   * Deterministic decision facts (policy caps, action targets, decimals). `exchangeRate` is a
   * fallback only — when the cycle reads a live sCSPR exchange rate it overrides this per cycle.
   */
  decisionInputs: DecisionInputs;
  oracleGuard: OracleGuardConfig;
  /** Trade sizes (USD) sampled for the price-impact curve; defaults to the DataService default. */
  impactSizesUsd?: number[];
}

export interface RunCycleInput {
  cycleId: string;
  /** A premium pull for this cycle (live x402 client result, or scenario-injected). */
  premium?: PremiumPullResult;
  /** Volatility estimate (ESTIMATED provenance) for the snapshot. */
  volatility?: VolatilityEstimate;
  /** Owner/breaker pause — when true the loop perceives nothing and acts on nothing. */
  paused?: boolean;
  /** Wall clock (ms); defaults to `Date.now()`. */
  now?: number;
}

export type CycleStage = 'paused' | 'perceived' | 'guarded' | 'decided' | 'acted';

export interface CycleResult {
  cycleId: string;
  /** How far the cycle progressed before completing or short-circuiting. */
  stage: CycleStage;
  /** False when the cycle produced no on-chain action (pause, oracle reject, or NoOp). */
  acted: boolean;
  reason?: string;
  perceptionHash?: string;
  decisionHash?: string;
  regime?: Regime;
  oracle?: OracleGuardResult;
  decision?: DecisionResult;
  execution?: ExecutionOutcome;
  circuit?: CircuitBreakerOutcome;
}

export class SentinelLoop {
  private readonly data: DataService;

  constructor(
    private readonly deps: SentinelLoopDeps,
    private readonly cfg: SentinelLoopConfig,
  ) {
    this.data = new DataService(deps.sources);
  }

  /** Run one bounded perceive→decide→act→prove cycle. Idempotent per `cycleId` via the CycleStore. */
  async runCycle(input: RunCycleInput): Promise<CycleResult> {
    const { cycleId } = input;
    const now = input.now ?? Date.now();

    // Owner / circuit-breaker pause stops a new cycle before it perceives anything.
    if (input.paused || this.deps.circuitBreaker.isTripped) {
      return {
        cycleId,
        stage: 'paused',
        acted: false,
        reason: input.paused ? 'owner pause active' : 'circuit breaker tripped',
      };
    }

    // PERCEIVE — collect raw inputs, assemble + hash the MarketSnapshot.
    const raw = await this.data.collect(this.cfg.impactSizesUsd);
    const { snapshot, perceptionHash } = await this.deps.scout.perceive({
      cycleId,
      raw,
      ...(input.premium ? { premium: input.premium } : {}),
      ...(input.volatility ? { volatility: input.volatility } : {}),
      now,
    });

    // GUARD — reject the cycle when the price signal can't be trusted (stale / dislocated).
    const oracle = evaluateOracle(
      {
        divergenceBps: snapshot.twapSpotDivergenceBps,
        heartbeatSec: raw.heartbeat,
        nowSec: Math.floor(now / 1000),
      },
      this.cfg.oracleGuard,
    );
    if (!oracle.ok) {
      return {
        cycleId,
        stage: 'guarded',
        acted: false,
        reason: oracle.reasons.join('; '),
        perceptionHash,
        oracle,
      };
    }

    // DECIDE — deliberate, clamp, and size the single concrete action. Use the live sCSPR rate.
    const exchangeRate = raw.exchangeRate
      ? exchangeRateToFloat(raw.exchangeRate)
      : this.cfg.decisionInputs.exchangeRate;
    const decisionInputs: DecisionInputs = { ...this.cfg.decisionInputs, exchangeRate };
    const decision = await this.deps.decisionEngine.decide(
      cycleId,
      snapshot,
      perceptionHash,
      decisionInputs,
    );

    // ACT — submit execute_rebalance and poll to finality (NoOp short-circuits without a tx).
    const execution = await this.deps.execution.execute({
      cycleId,
      action: decision.decision.finalAction,
      regime: decision.decision.regime,
      perceptionHash,
      decisionHash: decision.decisionHash,
    });

    // GUARD — feed the result to the breaker; a trip surfaces shouldPause for the owner pause tx.
    const circuit = this.deps.circuitBreaker.record(execution.result);

    return {
      cycleId,
      stage: 'acted',
      acted: execution.result === 'Success',
      ...(decision.decision.finalAction.kind === 'NoOp' ? { reason: decision.sized.reason } : {}),
      perceptionHash,
      decisionHash: decision.decisionHash,
      regime: decision.decision.regime,
      oracle,
      decision,
      execution,
      circuit,
    };
  }
}
