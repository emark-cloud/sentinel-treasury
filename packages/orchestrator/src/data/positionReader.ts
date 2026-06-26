/**
 * Depositor position + NAV/share reader (the "see my balance and where it's allocated" layer).
 *
 * The pure NAV/share math now lives in `@sentinel/shared` (`position.ts`) so the orchestrator and
 * the dashboard share one implementation that stays in lock-step with the on-chain valuation
 * (`vault.rs` `bucket_usd` / `total_nav_usd` / `redeem`). This module re-exports it and binds the
 * orchestrator's on-chain `ExchangeRateInputs` to the shared `ExchangeRate` shape.
 *
 * Multi-tenant: each depositor owns an explicit ledger slice read from the contract's per-account
 * views (`account_balances`); valuation (USD value + allocation) is the pure math here, kept in
 * lock-step with the on-chain `bucket_usd` / `compute_alloc`.
 */
export {
  bucketUsd,
  computeNavSnapshot,
  computeUserPosition,
  allocationBps,
  totalUsd,
  normalizeAccount,
} from '@sentinel/shared';
export type { NavInputs, ExchangeRate } from '@sentinel/shared';

// The orchestrator reads the rate as `ExchangeRateInputs` (bigint fields); it is structurally a
// `@sentinel/shared` `ExchangeRate`, so it drops into `NavInputs.rate` directly.
export type { ExchangeRateInputs } from './onchainReader.js';
