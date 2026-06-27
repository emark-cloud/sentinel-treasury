/**
 * Per-account valuation for the multi-tenant vault (spec §4 depositor flow). Lives in
 * `@sentinel/shared` because it is consumed on both sides of the boundary: the orchestrator
 * (`data/positionReader`) and the dashboard (server-side position API) must agree byte-for-byte
 * with what the contract does on-chain (`vault.rs` `bucket_usd` / `compute_alloc` /
 * `account_value_usd`), so the value a depositor sees equals what a withdraw/redeem actually pays.
 *
 * There are no shares: each depositor owns an explicit ledger slice (`cspr`/`scspr`/`csprusd`),
 * read directly from the contract's per-account views. Valuation is pure: balances + TWAP + the
 * live sCSPR rate → micro-USD. All USD values are micro-USD (1e6 = $1); balances are base-unit
 * decimal strings.
 */
import type { AllocationBps, NavSnapshot, UserPosition, VaultBalances } from './types/onchain.js';

/** Motes / sCSPR base-unit scale (9 decimals). */
const CSPR_SCALE = 1_000_000_000n;
const BPS = 10_000n;

type Numeric = string | bigint;
const big = (v: Numeric): bigint => (typeof v === 'bigint' ? v : BigInt(v));

/** Live sCSPR→CSPR rate inputs (`staked_cspr` / `total_supply`), as read from the staking contract. */
export interface ExchangeRate {
  stakedCspr: Numeric;
  totalSupply: Numeric;
}

/** Inputs needed to value a set of balances, mirroring the on-chain `bucket_usd` read. */
export interface NavInputs {
  balances: VaultBalances;
  /** CSPR/USD TWAP in micro-USD per CSPR. */
  twapMicros: Numeric;
  rate: ExchangeRate;
}

/** Micro-USD value of `motes` native CSPR at the given TWAP. */
function csprMotesToUsd(motes: bigint, twapMicros: bigint): bigint {
  return (motes * twapMicros) / CSPR_SCALE;
}

/**
 * The three buckets in micro-USD, exactly as the contract computes them: sCSPR → CSPR-equivalent
 * at the live rate → USD; stable is already micro-USD; CSPR via TWAP. Works for any balance set —
 * one account's ledger slice or the vault aggregate.
 */
export function bucketUsd(input: NavInputs): { scspr: bigint; csprusd: bigint; cspr: bigint } {
  const twap = big(input.twapMicros);
  const scsprBal = big(input.balances.scspr);
  const csprusdBal = big(input.balances.csprusd);
  const csprMotes = big(input.balances.cspr);
  const staked = big(input.rate.stakedCspr);
  const supply = big(input.rate.totalSupply);

  const scsprCsprEquiv = supply === 0n ? 0n : (scsprBal * staked) / supply;
  return {
    scspr: csprMotesToUsd(scsprCsprEquiv, twap),
    csprusd: csprusdBal, // 6-decimal stable ≈ micro-USD
    cspr: csprMotesToUsd(csprMotes, twap),
  };
}

/** USD-normalized allocation (bps) for a balance set; `scspr + csprusd + cspr == 10000`. */
export function allocationBps(input: NavInputs): AllocationBps {
  const b = bucketUsd(input);
  const total = b.scspr + b.csprusd + b.cspr;
  if (total === 0n) return { scspr: 0, csprusd: 0, cspr: 0 };
  const scspr = Number((b.scspr * BPS) / total);
  const csprusd = Number((b.csprusd * BPS) / total);
  return { scspr, csprusd, cspr: 10_000 - scspr - csprusd };
}

/** Total micro-USD value of a balance set. */
export function totalUsd(input: NavInputs): bigint {
  const b = bucketUsd(input);
  return b.scspr + b.csprusd + b.cspr;
}

/** Assemble the whole-vault aggregate TVL snapshot from the vault's total holdings. */
export function computeNavSnapshot(input: NavInputs): NavSnapshot {
  const b = bucketUsd(input);
  return {
    totalNavUsd: (b.scspr + b.csprusd + b.cspr).toString(),
    managedNavUsd: (b.scspr + b.csprusd).toString(),
    allocBps: allocationBps(input),
    balances: input.balances,
  };
}

/**
 * One account's position, valued from its *own* ledger slice (`account_balances`) at the live
 * price/rate — exactly what the contract's `account_value_usd` / `compute_alloc` return, and what
 * a withdraw/redeem pays out directly (no pro-rata pooling).
 */
export function computeUserPosition(
  account: string,
  balances: VaultBalances,
  price: { twapMicros: Numeric; rate: ExchangeRate },
): UserPosition {
  const input: NavInputs = { balances, twapMicros: price.twapMicros, rate: price.rate };
  return {
    account,
    balances,
    valueUsd: totalUsd(input).toString(),
    allocBps: allocationBps(input),
  };
}

/** Normalize an address key so event `depositor`/`account` fields match a queried account. */
export function normalizeAccount(account: string): string {
  return account.trim().toLowerCase().replace(/^0x/, '');
}
