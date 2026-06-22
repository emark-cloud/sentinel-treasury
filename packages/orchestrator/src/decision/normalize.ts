/**
 * USD normalization (spec §7.1) — turn on-chain base-unit balances into USD values and weights via
 * the Styks TWAP and the sCSPR exchange rate:
 *
 *   price(CSPR)    = twap
 *   price(sCSPR)   = twap * scspr_exchange_rate   // sCSPR appreciates vs CSPR over time
 *   price(csprUSD) = 1.0 (peg)
 *
 * The CSPR gas buffer is excluded from the investable total (spec §1.3). Weights are bps over the
 * three buckets (sCSPR, csprUSD, investable CSPR) and feed the pre/post-action allocation in the
 * receipt.
 */
import type { VaultBalances, AllocationBps } from '@sentinel/shared';
import { DEFAULT_DECIMALS } from './types.js';
import type { TokenDecimals, UsdValuation } from './types.js';

/** Base-unit decimal string → human units (e.g. motes → CSPR). */
export function baseToUnits(base: string, decimals: number): number {
  // Scale via bigint to avoid precision loss on large balances, then divide once.
  const n = BigInt(base);
  const scale = 10n ** BigInt(decimals);
  const whole = n / scale;
  const frac = n % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

function weightBps(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 10_000);
}

/**
 * Value the three buckets in USD and compute current weights (spec §7.1). `twapUsd` is the
 * CSPR/USD price; `exchangeRate` is CSPR per sCSPR; `csprBufferCspr` is held aside for gas.
 */
export function valuate(
  balances: VaultBalances,
  twapUsd: number,
  exchangeRate: number,
  csprBufferCspr = 100,
  decimals: TokenDecimals = DEFAULT_DECIMALS,
): UsdValuation {
  const csprTotal = baseToUnits(balances.cspr, decimals.cspr);
  const csprInvestable = Math.max(0, csprTotal - csprBufferCspr);
  const scspr = baseToUnits(balances.scspr, decimals.scspr);
  const stable = baseToUnits(balances.csprusd, decimals.csprusd);

  const csprUsd = csprInvestable * twapUsd;
  const scsprUsd = scspr * twapUsd * exchangeRate;
  const csprusdUsd = stable * 1.0;
  const totalUsd = csprUsd + scsprUsd + csprusdUsd;

  const weightsBps: AllocationBps = {
    scspr: weightBps(scsprUsd, totalUsd),
    csprusd: weightBps(csprusdUsd, totalUsd),
    cspr: weightBps(csprUsd, totalUsd),
  };
  return { csprUsd, scsprUsd, csprusdUsd, totalUsd, weightsBps };
}
