/**
 * Deterministic rule engine (spec §5(principle 5), §6.5) — the outer envelope, not just a safety
 * net. Pure functions, no LLM:
 *
 *  - `classifyRegime` / `deterministicVerdict` — the fallback Risk classification when the LLM is
 *    unavailable or malformed.
 *  - `fallbackAllocation` — the regime→allocation map (the fallback Treasury proposal).
 *  - `REGIME_BANDS` + `clampTargetBps` — the legal band the LLM proposal is **clamped** to, so the
 *    model can refine *within* sane bounds but never outside them (no free-form allocation reaches
 *    the chain).
 *  - `critiqueProposal` — the Risk agent's deterministic veto checks for the deliberation loop.
 */
import type { MarketSnapshot, RiskVerdict, AllocationProposal, Regime } from '@sentinel/shared';
import type { TargetBps, DecisionPolicy } from './types.js';

/** Per-regime legal band for the sCSPR weight (bps). The LLM is clamped into this range. */
export const REGIME_BANDS: Record<Regime, { minScsprBps: number; maxScsprBps: number }> = {
  Calm: { minScsprBps: 4000, maxScsprBps: 7000 },
  Elevated: { minScsprBps: 3000, maxScsprBps: 5000 },
  Stressed: { minScsprBps: 1000, maxScsprBps: 3000 },
};

/** The fallback target allocation for a regime (spec §6.5). sCSPR centre of each band. */
export function fallbackAllocation(regime: Regime): TargetBps {
  switch (regime) {
    case 'Calm':
      return { scspr: 6000, csprusd: 4000, csprBuffer: 0 };
    case 'Elevated':
      return { scspr: 4000, csprusd: 6000, csprBuffer: 0 };
    case 'Stressed':
      return { scspr: 2000, csprusd: 8000, csprBuffer: 0 };
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * Deterministic regime risk score (0..100) from a snapshot. Combines TWAP/spot divergence,
 * volatility, and the optional x402 premium risk index into a single conservative number. Used by
 * the fallback Risk classification; the LLM may override within its schema.
 */
export function regimeRiskScore(snap: MarketSnapshot): number {
  // Divergence: 0 bps → 0, ≥1000 bps (10%) → full weight (40 pts).
  const divPart = (Math.min(Math.abs(snap.twapSpotDivergenceBps), 1000) / 1000) * 40;
  // Annualized volatility: 0% → 0, ≥200% → full weight (30 pts).
  const volPart = (Math.min(Math.max(snap.volatility.annualizedPct, 0), 200) / 200) * 30;
  // Premium risk index (0..100) → up to 30 pts.
  const premPart = ((snap.premiumSignal?.riskIndex ?? 0) / 100) * 30;
  return clampInt(divPart + volPart + premPart, 0, 100);
}

/** Map a deterministic risk score to a regime. */
export function classifyRegime(score: number): Regime {
  if (score < 25) return 'Calm';
  if (score < 55) return 'Elevated';
  return 'Stressed';
}

/**
 * Deterministic Risk verdict — the fallback when the LLM turn fails or is malformed. The hard
 * limits are conservative: sCSPR ceiling = regime band max, action ceiling = the per-action cap.
 */
export function deterministicVerdict(snap: MarketSnapshot, policy: DecisionPolicy): RiskVerdict {
  const riskScore = regimeRiskScore(snap);
  const regime = classifyRegime(riskScore);
  const drivers: string[] = [];
  if (snap.twapSpotDivergenceBps >= 50)
    drivers.push(`twap-spot divergence ${(snap.twapSpotDivergenceBps / 100).toFixed(2)}%`);
  if (snap.volatility.annualizedPct >= 30)
    drivers.push(`volatility ${snap.volatility.annualizedPct.toFixed(0)}% annualized`);
  if (snap.premiumSignal) drivers.push(`premium risk index ${snap.premiumSignal.riskIndex}`);
  if (drivers.length === 0) drivers.push('no elevated risk signals');
  return {
    regime,
    riskScore,
    drivers,
    hardLimits: {
      maxScsprBps: REGIME_BANDS[regime].maxScsprBps,
      maxActionUsd: policy.perActionCapUsd,
    },
    rationale: `Deterministic classification: risk score ${riskScore} → ${regime}.`,
  };
}

/**
 * Clamp a proposed target allocation into the legal envelope (spec §6.5): the sCSPR weight is
 * intersected with the regime band, the policy bounds `[minScsprBps, maxScsprBps]`, and the Risk
 * agent's `hardLimits.maxScsprBps`. csprUSD takes the remainder after the (clamped) buffer, so the
 * result always sums to 10000 and never escapes the bounds — regardless of what the LLM proposed.
 */
export function clampTargetBps(
  proposed: TargetBps,
  regime: Regime,
  policy: DecisionPolicy,
  hardLimits: RiskVerdict['hardLimits'],
): TargetBps {
  const band = REGIME_BANDS[regime];
  const lo = Math.max(band.minScsprBps, policy.minScsprBps);
  const hi = Math.min(band.maxScsprBps, policy.maxScsprBps, hardLimits.maxScsprBps);
  // If the bounds invert (mis-configured), collapse to the lower bound (most conservative).
  const upper = Math.max(lo, hi);
  const buffer = clampInt(proposed.csprBuffer ?? 0, 0, 2000);
  const scspr = clampInt(proposed.scspr, lo, upper);
  const csprusd = 10_000 - scspr - buffer;
  return { scspr, csprusd, csprBuffer: buffer };
}

export interface Critique {
  approved: boolean;
  reasons: string[];
}

/**
 * Risk agent's deterministic critique of a Treasury proposal (spec §6.2) — the veto. Checks the
 * proposal sums correctly, sits inside the regime band, respects the policy bounds and the Risk
 * hard limits, and keeps expected slippage under the ceiling. Returns the reasons for a reject so
 * Treasury can revise.
 */
export function critiqueProposal(
  proposal: AllocationProposal,
  verdict: RiskVerdict,
  policy: DecisionPolicy,
): Critique {
  const reasons: string[] = [];
  const { scspr, csprusd, csprBuffer } = proposal.targetBps;
  if (scspr + csprusd + csprBuffer !== 10_000) {
    reasons.push(`targetBps must sum to 10000 (got ${scspr + csprusd + csprBuffer})`);
  }
  const band = REGIME_BANDS[verdict.regime];
  if (scspr < band.minScsprBps || scspr > band.maxScsprBps) {
    reasons.push(
      `scspr ${scspr} bps outside ${verdict.regime} band [${band.minScsprBps}, ${band.maxScsprBps}]`,
    );
  }
  if (scspr < policy.minScsprBps || scspr > policy.maxScsprBps) {
    reasons.push(
      `scspr ${scspr} bps outside policy bounds [${policy.minScsprBps}, ${policy.maxScsprBps}]`,
    );
  }
  if (scspr > verdict.hardLimits.maxScsprBps) {
    reasons.push(`scspr ${scspr} bps exceeds Risk hard limit ${verdict.hardLimits.maxScsprBps}`);
  }
  if (proposal.expectedSlippageBps > policy.maxSlippageBps) {
    reasons.push(
      `expected slippage ${proposal.expectedSlippageBps} bps exceeds ceiling ${policy.maxSlippageBps}`,
    );
  }
  return { approved: reasons.length === 0, reasons };
}
