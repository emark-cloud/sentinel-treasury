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
import type { Regime, VaultBalances } from '@sentinel/shared';
import { DataService } from './data/dataService.js';
import type { PerceptionSources, RawPerception } from './data/dataService.js';
import { exchangeRateToFloat } from './data/onchainReader.js';
import type { Scout } from './agents/scout.js';
import type { VolatilityEstimate } from './agents/scout.js';
import type { PremiumPullResult } from './x402/client.js';
import type { DecisionEngine } from './decision/deliberate.js';
import type { DecisionResult } from './decision/deliberate.js';
import type { DecisionInputs, DecisionPolicy } from './decision/types.js';
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

/**
 * A depositor's per-cycle context in the multi-tenant vault: their account-hash, their current
 * ledger slice (overrides the snapshot's `vault` balances so sizing is account-scoped), and their
 * effective (envelope-clamped) policy (overrides the decision caps/band). All three are read from
 * the vault's per-account views before the cycle.
 */
export interface AccountContext {
  accountHashHex: string;
  balances: VaultBalances;
  policy: DecisionPolicy;
}

export interface RunCycleInput {
  cycleId: string;
  /** The depositor this cycle acts for (multi-tenant: one account per cycle). */
  account: AccountContext;
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
  /** Account-hash (hex) this cycle acted for. */
  account?: string;
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

  /** Run one bounded perceive→decide→act→prove cycle for one account. Idempotent per `cycleId`. */
  async runCycle(input: RunCycleInput): Promise<CycleResult> {
    if (input.paused || this.deps.circuitBreaker.isTripped) {
      return this.pausedResult(input);
    }
    // PERCEIVE — collect the (account-agnostic) market inputs once, then run the account cycle.
    const raw = await this.data.collect(this.cfg.impactSizesUsd);
    return this.runWithRaw(raw, input);
  }

  /**
   * Per-account iteration (the multi-tenant loop): perceive the market **once**, then run a bounded
   * cycle for each depositor against *their own* ledger slice + policy. One receipt per account.
   * `base.cycleId` is suffixed with each account's short hash to keep idempotency keys distinct.
   */
  async runForAccounts(
    accounts: AccountContext[],
    base: Omit<RunCycleInput, 'account'>,
  ): Promise<CycleResult[]> {
    if (base.paused || this.deps.circuitBreaker.isTripped) {
      return [this.pausedResult({ ...base, account: accounts[0]! })];
    }
    const raw = await this.data.collect(this.cfg.impactSizesUsd);
    const results: CycleResult[] = [];
    for (const account of accounts) {
      const cycleId = `${base.cycleId}:${account.accountHashHex.slice(0, 8)}`;
      results.push(await this.runWithRaw(raw, { ...base, cycleId, account }));
    }
    return results;
  }

  private pausedResult(input: RunCycleInput | (Omit<RunCycleInput, 'account'> & { account: AccountContext })): CycleResult {
    return {
      cycleId: input.cycleId,
      account: input.account.accountHashHex,
      stage: 'paused',
      acted: false,
      reason: input.paused ? 'owner pause active' : 'circuit breaker tripped',
    };
  }

  /** The post-perceive cycle body, scoped to one account (shared by single + per-account paths). */
  private async runWithRaw(rawMarket: RawPerception, input: RunCycleInput): Promise<CycleResult> {
    const { cycleId, account } = input;
    const now = input.now ?? Date.now();

    // Scope the snapshot to this account's ledger slice so sizing is account-specific.
    const raw: RawPerception = { ...rawMarket, balances: account.balances };
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
        account: account.accountHashHex,
        stage: 'guarded',
        acted: false,
        reason: oracle.reasons.join('; '),
        perceptionHash,
        oracle,
      };
    }

    // DECIDE — deliberate, clamp, and size the single concrete action against *this account's*
    // policy (caps/band) and the live sCSPR rate.
    const exchangeRate = raw.exchangeRate
      ? exchangeRateToFloat(raw.exchangeRate)
      : this.cfg.decisionInputs.exchangeRate;
    const decisionInputs: DecisionInputs = {
      ...this.cfg.decisionInputs,
      exchangeRate,
      policy: account.policy,
    };
    const decision = await this.deps.decisionEngine.decide(
      cycleId,
      snapshot,
      perceptionHash,
      decisionInputs,
    );

    // ACT — submit execute_rebalance(account, …) and poll to finality (NoOp short-circuits).
    const execution = await this.deps.execution.execute({
      cycleId,
      accountHashHex: account.accountHashHex,
      action: decision.decision.finalAction,
      regime: decision.decision.regime,
      perceptionHash,
      decisionHash: decision.decisionHash,
    });

    // GUARD — feed the result to the breaker; a trip surfaces shouldPause for the owner pause tx.
    const circuit = this.deps.circuitBreaker.record(execution.result);

    return {
      cycleId,
      account: account.accountHashHex,
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
