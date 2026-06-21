//! Sentinel Treasury — on-chain layer (Odra, upgradable).
//!
//! Two contracts (spec §4), implemented in Phase 2 (see `TODO.md`):
//! - [`audit_log`] — append-only, tamper-evident `Receipt` store. No update/delete.
//! - [`vault`] — custody + cap/whitelist/slippage enforcement + `execute_rebalance`.
//!
//! Both deploy as Casper contract packages (upgradable via the Odra Casper backend at
//! `cargo odra build` / Livenet time — the spec's `odra_cfg_is_upgradable` is an Odra-1.x
//! spelling; 2.x packages are upgradable by construction). The on-chain `Receipt`/enum shapes
//! are mirrored off-chain by `@sentinel/shared` (`packages/shared/src/types/onchain.ts`); the
//! canonical reference lives in `onchain-reference.md`. Keep the two in sync.
//!
//! Phase 2 lands the storage, entry points, and the `execute_rebalance` guardrail flow.

// The Odra `#[odra::module]` macro emits `#[cfg(odra_module)]` gates the compiler can't see.
#![allow(unexpected_cfgs)]

pub mod audit_log;
pub mod external;
pub mod types;
pub mod vault;

#[cfg(test)]
mod mocks;
#[cfg(test)]
mod tests;
