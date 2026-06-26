//! Shared on-chain data models for the Sentinel Treasury contracts (spec §4.2.1 & §12.1).
//!
//! These are the Rust source of truth that `@sentinel/shared`
//! (`packages/shared/src/types/onchain.ts`) mirrors off-chain. The two hashes carried in
//! a [`Receipt`] (`perception_hash`, `decision_hash`) are produced **off-chain** over
//! canonical JSON and stored verbatim here; the contract never recomputes them. Keep the
//! variant names and field order in lockstep with `onchain-reference.md`.

use odra::casper_types::{U256, U512};
use odra::prelude::*;

/// The single corrective step a cycle may take (spec §12.1).
///
/// `SwapToStable` = de-risk (sCSPR→stable, instant DEX path); `SwapToRisk` = re-risk
/// (stable→sCSPR); `Stake` = CSPR→sCSPR via Wise; `Unstake` = deliberate exit (~16h delay).
#[odra::odra_type]
pub enum ActionKind {
    Stake,
    Unstake,
    SwapToStable,
    SwapToRisk,
    NoOp,
}

/// Market regime classification from the Risk agent (spec §6.3). Carried into the receipt.
#[odra::odra_type]
pub enum Regime {
    Calm,
    Elevated,
    Stressed,
}

/// Outcome of an `execute_rebalance` call (spec §12.1).
#[odra::odra_type]
pub enum ActionResult {
    Success,
    Reverted,
    Skipped,
}

/// The managed asset an action moves. `Csprusd` is WUSDT on Testnet (D-005) — the field
/// name stays `csprusd` so off-chain mirrors do not churn.
#[odra::odra_type]
pub enum Asset {
    Cspr,
    Scspr,
    Csprusd,
}

/// Owner-settable guardrail policy (spec §12.1). USD caps are denominated in **micro-USD**
/// (USD × 10^6) so they line up with the 6-decimal stable refuge; the on-chain Styks read
/// converts every action's notional into the same unit before the cap checks.
/// Note: bps fields are `u32`, not `u16` — Casper's CL type system has no 16-bit integer, so
/// `u16` cannot cross the contract ABI. Values still live in `[0, 10000]`.
#[odra::odra_type]
pub struct PolicyConfig {
    pub per_action_cap_usd: U256,
    pub daily_cap_usd: U256,
    pub max_slippage_bps: u32,
    pub min_scspr_bps: u32,
    pub max_scspr_bps: u32,
}

/// USD-normalized bucket weights in basis points; `scspr + csprusd + cspr == 10000`.
#[odra::odra_type]
pub struct AllocationBps {
    pub scspr: u32,
    pub csprusd: u32,
    pub cspr: u32,
}

/// Base-unit balances held by the vault. `cspr` is native (motes, U512); the two tokens are
/// CEP-18 balances (U256).
#[odra::odra_type]
pub struct VaultBalances {
    pub cspr: U512,
    pub scspr: U256,
    pub csprusd: U256,
}

/// The compact, tamper-evident record appended to the AuditLog (spec §4.2.1).
///
/// `perception_hash`/`decision_hash` anchor the full off-chain artifacts: a verifier
/// re-hashes the retained `MarketSnapshot`/`Decision` JSON and asserts equality with these
/// fields (spec §9.2). `deploy_hash` is filled by the off-chain proof layer after finality
/// (a contract cannot read its own enclosing transaction hash); it is zero when the vault
/// records the receipt cross-contract, and reconciled against the `RebalanceExecuted` event.
#[odra::odra_type]
pub struct Receipt {
    pub action_id: u64,
    pub timestamp: u64,
    pub agent: Address,
    /// The depositor account whose ledger slice this action moved (multi-tenant vault). The agent
    /// names it as a separate `execute_rebalance` argument; recording it here makes every receipt
    /// answer "whose funds?" without an off-chain join.
    pub account: Address,
    pub action_kind: ActionKind,
    pub regime: Regime,
    pub perception_hash: [u8; 32],
    pub decision_hash: [u8; 32],
    pub pre_alloc_bps: AllocationBps,
    pub post_alloc_bps: AllocationBps,
    pub amount: U256,
    pub notional_usd: U256,
    pub target: Address,
    pub deploy_hash: [u8; 32],
    pub result: ActionResult,
    pub cspr_usd_twap: U256,
}

/// Agent input to `execute_rebalance` — mirrors off-chain `RebalanceAction` (decision.ts)
/// plus the receipt metadata the vault needs to record proof atomically. No free-form value
/// here can breach an invariant: every field is re-checked against on-chain policy before use.
#[odra::odra_type]
pub struct RebalanceParams {
    pub kind: ActionKind,
    pub asset: Asset,
    /// Base units of the input asset to move.
    pub amount: U256,
    /// Whitelisted target contract (router for swaps, staking for stake/unstake).
    pub target: Address,
    /// Slippage floor for swaps (`amount_out_min`); ignored for non-swap kinds.
    pub min_out: U256,
    /// Swap route as token-contract addresses; empty for non-swap kinds. The router/MCP
    /// pick the path off-chain; the vault passes it through and enforces `min_out`.
    pub path: Vec<Address>,
    /// blake2b-256 of the canonical `MarketSnapshot` JSON.
    pub perception_hash: [u8; 32],
    /// blake2b-256 of the canonical `Decision` JSON (incl. debate transcript).
    pub decision_hash: [u8; 32],
    pub regime: Regime,
}
