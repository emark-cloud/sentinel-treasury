//! Sentinel Treasury — on-chain layer (Odra, upgradable).
//!
//! Two contracts (spec §4), implemented in Phase 2 (see `TODO.md`):
//! - [`audit_log`] — append-only, tamper-evident `Receipt` store. No update/delete.
//! - [`vault`] — custody + cap/whitelist/slippage enforcement + `execute_rebalance`.
//!
//! Both are `odra_cfg_is_upgradable = true`. The on-chain `Receipt`/enum shapes are
//! mirrored off-chain by `@sentinel/shared` (`packages/shared/src/types/onchain.ts`);
//! the canonical reference lives in `onchain-reference.md`. Keep the two in sync.
//!
//! Phase 1 is the crate skeleton only — the modules below are placeholders so the
//! workspace layout is in place; the storage, entry points, and guardrail flow land in
//! Phase 2.

// pub mod audit_log;
// pub mod vault;
