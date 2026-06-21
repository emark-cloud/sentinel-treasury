//! External contract interfaces the vault calls cross-contract under **Mode A** (D-001).
//!
//! ABIs confirmed in the Phase-0 spike (`docs/abi-spike.md`): CSPR.trade Router, Wise Lending
//! liquid staking (the sCSPR package is both the staking contract *and* the sCSPR CEP-18 token),
//! the WUSDT CEP-18 stable refuge, and the Styks price feed (on-chain USD read, D-002).
//!
//! Odra generates a `…ContractRef` per trait; the vault binds each to a stored package address
//! and calls it like a local module. Keys ↔ `Address` and `Vec<Key>` ↔ `Vec<Address>`.

use odra::casper_types::{U256, U512};
use odra::prelude::*;

/// CEP-18 surface used for `approve` (pre-swap) and `balance_of` (post-action valuation).
/// Both sCSPR and WUSDT expose this.
#[odra::external_contract]
pub trait Cep18 {
    fn approve(&mut self, spender: Address, amount: U256);
    fn balance_of(&self, address: Address) -> U256;
    fn transfer(&mut self, recipient: Address, amount: U256);
    fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256);
    fn decimals(&self) -> u8;
}

/// CSPR.trade Router (Uniswap-V2 style). Exact-in swaps with an on-chain `amount_out_min`
/// floor — the second half of the doubly-enforced slippage ceiling (spec §11).
#[odra::external_contract]
pub trait Router {
    fn swap_exact_tokens_for_tokens(
        &mut self,
        amount_in: U256,
        amount_out_min: U256,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<U256>;
    fn get_amounts_out(&self, amount_in: U256, path: Vec<Address>) -> Vec<U256>;
}

/// Wise Lending liquid staking. `stake()` is payable — CSPR is attached via `with_tokens`,
/// not a parameter (abi-spike OPEN item resolved to the purse/loose-pool handoff). The
/// sCSPR→CSPR exchange rate is COMPUTED as `staked_cspr() / total_supply()` (no getter).
#[odra::external_contract]
pub trait Staking {
    fn stake(&mut self);
    fn unstake(&mut self, scspr_amount: U256);
    fn staked_cspr(&self) -> U512;
    fn total_supply(&self) -> U256;
}

/// Styks price feed — `get_twap_price("CSPRUSD")` is the on-chain USD oracle (D-002). The U64
/// fixed-point scale is captured by [`crate::vault::STYKS_TWAP_DECIMALS`].
#[odra::external_contract]
pub trait StyksPriceFeed {
    fn get_twap_price(&self, id: String) -> Option<u64>;
    fn get_last_heartbeat(&self) -> Option<u64>;
}
