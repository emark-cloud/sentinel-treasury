/**
 * Depositor position + NAV/share reader (the "see my balance and where it's allocated" layer).
 *
 * The pure NAV/share math now lives in `@sentinel/shared` (`position.ts`) so the orchestrator and
 * the dashboard share one implementation that stays in lock-step with the on-chain valuation
 * (`vault.rs` `bucket_usd` / `total_nav_usd` / `redeem`). This module re-exports it and binds the
 * orchestrator's on-chain `ExchangeRateInputs` to the shared `ExchangeRate` shape.
 *
 * Shares come from the vault's `Deposited`/`Redeemed` event stream (mint/burn happen only there),
 * reconstructed via `buildShareLedger`; NAV is computed from the three balances + Styks TWAP + the
 * live sCSPR rate. The event source is injected so the CSPR.cloud wiring stays a thin adapter.
 */
export {
  bucketUsd,
  computeNavSnapshot,
  computeUserPosition,
  buildShareLedger,
  StaticShareLedger,
  readPositions,
  normalizeAccount,
} from '@sentinel/shared';
export type {
  NavInputs,
  ExchangeRate,
  ShareLedger,
  ShareEventSource,
} from '@sentinel/shared';

// The orchestrator reads the rate as `ExchangeRateInputs` (bigint fields); it is structurally a
// `@sentinel/shared` `ExchangeRate`, so it drops into `NavInputs.rate` directly.
export type { ExchangeRateInputs } from './onchainReader.js';
