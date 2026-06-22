/**
 * Decision sizing (spec §7.2, §7.3) — turn an agreed (clamped) target allocation into the single
 * concrete, capped, slippage-bounded `RebalanceAction` for this cycle. This is the deterministic
 * step that guarantees **no free-form amount reaches the chain**: whatever the LLM proposed, the
 * amount here is derived from USD deltas ∩ caps ∩ pool depth, and `minOut` from the slippage
 * ceiling (re-checked on-chain).
 *
 * Selection (spec §7.2): execute the *single largest corrective action* — de-risk into the stable
 * via a DEX swap (fast path), or grow into sCSPR by staking liquid CSPR (or swapping stable→CSPR
 * when no liquid CSPR is available). Sizes converge to target over successive cycles.
 */
import type { RebalanceAction, AllocationBps, PriceImpactSample } from '@sentinel/shared';
import { DEFAULT_DECIMALS } from './types.js';
import type { TargetBps, DecisionInputs, UsdValuation } from './types.js';

export interface SizedDecision {
  action: RebalanceAction;
  /** USD notional of the action (0 for NoOp). */
  sizeUsd: number;
  /** Realized expected slippage at the chosen size (bps). */
  expectedSlippageBps: number;
  preAllocBps: AllocationBps;
  postAllocBps: AllocationBps;
  /** Human-readable reason, e.g. why a NoOp was chosen. */
  reason: string;
}

/**
 * Linearly interpolate the price-impact curve at `sizeUsd` (bps). The curve is treated as a
 * monotonic function anchored at (0, 0); above the largest sample it extrapolates along the last
 * segment's slope (conservative — impact keeps rising with size).
 */
export function impactAt(curve: PriceImpactSample[], sizeUsd: number): number {
  if (sizeUsd <= 0) return 0;
  const pts: PriceImpactSample[] = [
    { sizeUsd: 0, bps: 0 },
    ...[...curve].sort((a, b) => a.sizeUsd - b.sizeUsd),
  ];
  for (let i = 1; i < pts.length; i++) {
    const lo = pts[i - 1]!;
    const hi = pts[i]!;
    if (sizeUsd <= hi.sizeUsd) {
      const span = hi.sizeUsd - lo.sizeUsd;
      if (span <= 0) return hi.bps;
      const t = (sizeUsd - lo.sizeUsd) / span;
      return lo.bps + t * (hi.bps - lo.bps);
    }
  }
  // Extrapolate beyond the last sample using the last segment's slope.
  const last = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2] ?? { sizeUsd: 0, bps: 0 };
  const span = last.sizeUsd - prev.sizeUsd;
  const slope = span > 0 ? (last.bps - prev.bps) / span : 0;
  return last.bps + slope * (sizeUsd - last.sizeUsd);
}

/**
 * Largest trade size ≤ `desiredUsd` whose price impact stays under `ceilingBps` (spec §7.3:
 * shrink the trade to fit the slippage ceiling). Returns 0 when even an infinitesimal trade
 * exceeds the ceiling. Impact is monotonic in size, so a bounded bisection converges.
 */
export function shrinkToCeiling(
  curve: PriceImpactSample[],
  ceilingBps: number,
  desiredUsd: number,
): number {
  if (desiredUsd <= 0) return 0;
  if (impactAt(curve, desiredUsd) <= ceilingBps) return desiredUsd;
  let lo = 0;
  let hi = desiredUsd;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (impactAt(curve, mid) <= ceilingBps) lo = mid;
    else hi = mid;
  }
  return lo;
}

function unitsToBase(units: number, decimals: number): string {
  const scale = 10 ** decimals;
  return BigInt(Math.max(0, Math.round(units * scale))).toString();
}

function minOutBase(expectedOutUnits: number, decimals: number, maxSlippageBps: number): string {
  const scale = 10 ** decimals;
  const floored = Math.floor(expectedOutUnits * scale * ((10_000 - maxSlippageBps) / 10_000));
  return BigInt(Math.max(0, floored)).toString();
}

function reweigh(scsprUsd: number, csprusdUsd: number, csprUsd: number): AllocationBps {
  const total = scsprUsd + csprusdUsd + csprUsd;
  const bps = (p: number): number => (total <= 0 ? 0 : Math.round((p / total) * 10_000));
  return { scspr: bps(scsprUsd), csprusd: bps(csprusdUsd), cspr: bps(csprUsd) };
}

function noop(val: UsdValuation, reason: string): SizedDecision {
  return {
    action: { kind: 'NoOp', asset: 'CSPR', amount: '0', target: '' },
    sizeUsd: 0,
    expectedSlippageBps: 0,
    preAllocBps: val.weightsBps,
    postAllocBps: val.weightsBps,
    reason,
  };
}

/**
 * Compute the single concrete action for a cycle from the clamped target allocation, the USD
 * valuation, and the cycle's caps (spec §7.2/§7.3). `maxActionUsd` is the Risk agent's per-cycle
 * action ceiling (`RiskVerdict.hardLimits.maxActionUsd`).
 */
export function computeFinalAction(
  target: TargetBps,
  val: UsdValuation,
  twapUsd: number,
  curve: PriceImpactSample[],
  inputs: DecisionInputs,
  maxActionUsd: number,
): SizedDecision {
  const decimals = inputs.decimals ?? DEFAULT_DECIMALS;
  const { policy } = inputs;
  const minTrade = policy.minTradeUsd ?? 1;
  const priceScspr = twapUsd * inputs.exchangeRate;

  if (val.totalUsd <= 0 || twapUsd <= 0) return noop(val, 'no USD valuation available');

  // Per-cycle USD ceiling: per-action cap ∩ Risk action limit ∩ remaining daily headroom.
  const cap = Math.min(policy.perActionCapUsd, maxActionUsd, policy.dayRemainingUsd);
  if (cap < minTrade) return noop(val, 'daily/per-action cap headroom below minimum trade size');

  const targetScsprUsd = (val.totalUsd * target.scspr) / 10_000;
  const targetStableUsd = (val.totalUsd * target.csprusd) / 10_000;
  const deltaScspr = targetScsprUsd - val.scsprUsd; // >0 ⇒ need more risk
  const deltaStable = targetStableUsd - val.csprusdUsd; // >0 ⇒ need more protection

  // De-risk dominates when we need more stable and that need is the larger of the two.
  if (deltaStable > minTrade && deltaStable >= deltaScspr) {
    // SwapToStable: sell sCSPR → stable (the fast de-risk path; spec §1.4).
    let sizeUsd = Math.min(deltaStable, cap, val.scsprUsd);
    sizeUsd = shrinkToCeiling(curve, policy.maxSlippageBps, sizeUsd);
    if (sizeUsd < minTrade) return noop(val, 'de-risk size below minimum after slippage shrink');
    const amountScspr = sizeUsd / priceScspr;
    const action: RebalanceAction = {
      kind: 'SwapToStable',
      asset: 'sCSPR',
      amount: unitsToBase(amountScspr, decimals.scspr),
      target: inputs.targets.router,
      minOut: minOutBase(sizeUsd, decimals.csprusd, policy.maxSlippageBps),
    };
    return {
      action,
      sizeUsd,
      expectedSlippageBps: Math.round(impactAt(curve, sizeUsd)),
      preAllocBps: val.weightsBps,
      postAllocBps: reweigh(val.scsprUsd - sizeUsd, val.csprusdUsd + sizeUsd, val.csprUsd),
      reason: `de-risk ${sizeUsd.toFixed(2)} USD sCSPR→stable toward ${target.scspr / 100}% sCSPR`,
    };
  }

  // Otherwise grow toward sCSPR when the target asks for more risk.
  if (deltaScspr > minTrade) {
    if (val.csprUsd >= minTrade) {
      // Stake liquid CSPR → sCSPR (no swap, so no slippage / minOut).
      const sizeUsd = Math.min(deltaScspr, cap, val.csprUsd);
      if (sizeUsd < minTrade) return noop(val, 'stake size below minimum');
      const amountCspr = sizeUsd / twapUsd;
      return {
        action: {
          kind: 'Stake',
          asset: 'CSPR',
          amount: unitsToBase(amountCspr, decimals.cspr),
          target: inputs.targets.staking,
        },
        sizeUsd,
        expectedSlippageBps: 0,
        preAllocBps: val.weightsBps,
        postAllocBps: reweigh(val.scsprUsd + sizeUsd, val.csprusdUsd, val.csprUsd - sizeUsd),
        reason: `grow ${sizeUsd.toFixed(2)} USD CSPR→sCSPR (stake) toward ${target.scspr / 100}% sCSPR`,
      };
    }
    // No liquid CSPR: swap stable → CSPR (risk-on) via the router.
    let sizeUsd = Math.min(deltaScspr, cap, val.csprusdUsd);
    sizeUsd = shrinkToCeiling(curve, policy.maxSlippageBps, sizeUsd);
    if (sizeUsd < minTrade) return noop(val, 'risk-on size below minimum after slippage shrink');
    const expectedOutCspr = sizeUsd / twapUsd;
    return {
      action: {
        kind: 'SwapToRisk',
        asset: 'csprUSD',
        amount: unitsToBase(sizeUsd, decimals.csprusd),
        target: inputs.targets.router,
        minOut: minOutBase(expectedOutCspr, decimals.cspr, policy.maxSlippageBps),
      },
      sizeUsd,
      expectedSlippageBps: Math.round(impactAt(curve, sizeUsd)),
      preAllocBps: val.weightsBps,
      postAllocBps: reweigh(val.scsprUsd, val.csprusdUsd - sizeUsd, val.csprUsd + sizeUsd),
      reason: `risk-on ${sizeUsd.toFixed(2)} USD stable→CSPR toward ${target.scspr / 100}% sCSPR`,
    };
  }

  return noop(val, 'allocation already within tolerance of target');
}
