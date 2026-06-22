/**
 * Shared inputs for the decision layer (spec §7) — the deterministic facts the rule engine and
 * sizing math need on top of the `MarketSnapshot` and `RiskVerdict`. All USD figures are plain
 * numbers (dollars); on-chain base units are handled inside the sizing module.
 */
import type { AllocationBps } from '@sentinel/shared';

/** sCSPR / csprUSD(WUSDT) target weights (bps), summing to 10000 (spec §6.3). */
export interface TargetBps {
  scspr: number;
  csprusd: number;
  csprBuffer: number;
}

/** Token base-unit decimals used to convert balances ⇄ USD (WUSDT=6 on Testnet — D-005). */
export interface TokenDecimals {
  cspr: number;
  scspr: number;
  /** Stable refuge (WUSDT). */
  csprusd: number;
}

export const DEFAULT_DECIMALS: TokenDecimals = { cspr: 9, scspr: 9, csprusd: 6 };

/** Policy caps the cycle is bounded by (mirrors on-chain `PolicyConfig`, USD-denominated). */
export interface DecisionPolicy {
  perActionCapUsd: number;
  dailyCapUsd: number;
  /** Remaining daily headroom (vault `day_remaining_usd`). */
  dayRemainingUsd: number;
  maxSlippageBps: number;
  minScsprBps: number;
  maxScsprBps: number;
  /** CSPR held aside for gas, excluded from allocation math (spec §1.3). Default 100 CSPR. */
  csprBufferCspr?: number;
  /** Smallest action worth executing; below this the cycle NoOps. Default $1. */
  minTradeUsd?: number;
}

/** Whitelisted target contracts (package hashes) per action kind. */
export interface ActionTargets {
  /** CSPR.trade Router — Swap* actions. */
  router: string;
  /** Wise Lending staking — Stake/Unstake. */
  staking: string;
}

/** Everything the deterministic decision logic needs besides the snapshot + verdict. */
export interface DecisionInputs {
  /** sCSPR→CSPR redemption rate as a float (CSPR per sCSPR); see `exchangeRateToFloat`. */
  exchangeRate: number;
  policy: DecisionPolicy;
  targets: ActionTargets;
  decimals?: TokenDecimals;
}

/** USD valuation of the three buckets + resulting weights (spec §7.1). */
export interface UsdValuation {
  /** USD value of the *investable* CSPR (total CSPR minus the gas buffer). */
  csprUsd: number;
  scsprUsd: number;
  csprusdUsd: number;
  totalUsd: number;
  /** Current weights in bps over (sCSPR, csprUSD, CSPR investable). */
  weightsBps: AllocationBps;
}
