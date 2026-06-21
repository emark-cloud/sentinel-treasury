//! Test-only mock protocols (MockVM). These stand in for the real Testnet contracts so the
//! vault's guardrail flow can be exercised end-to-end without the network. They are *not*
//! built to WASM (compiled under `#[cfg(test)]` only) and are intentionally permissive — they
//! model just enough behavior (token movement, payable stake, oracle price) to drive the
//! invariant tests; they are not faithful reimplementations of the real protocols.
//!
//! NB: Casper dispatches cross-contract arguments **by name**, so every entry-point parameter
//! name here must match the corresponding `external_contract` trait arg in `crate::external`
//! exactly — a `_`-prefixed param would rename the ABI arg and break the call.
#![allow(unused_variables)]

use odra::casper_types::{U256, U512};
use odra::prelude::*;
use odra::uints::{ToU256, ToU512};
use odra::ContractRef;

/// Mint/burn surface the mock router uses to move tokens during a swap.
#[odra::external_contract]
pub trait Mintable {
    fn mint(&mut self, to: Address, amount: U256);
    fn burn(&mut self, from: Address, amount: U256);
}

// ---------------------------------------------------------------- MockToken (CEP-18: WUSDT)

#[odra::module]
pub struct MockToken {
    balances: Mapping<Address, U256>,
    supply: Var<U256>,
    decimals: Var<u8>,
}

#[odra::module]
impl MockToken {
    pub fn init(&mut self, decimals: u8) {
        self.decimals.set(decimals);
        self.supply.set(U256::zero());
    }
    pub fn mint(&mut self, to: Address, amount: U256) {
        let b = self.balances.get(&to).unwrap_or_default();
        self.balances.set(&to, b + amount);
        self.supply.set(self.supply.get_or_default() + amount);
    }
    pub fn burn(&mut self, from: Address, amount: U256) {
        let b = self.balances.get(&from).unwrap_or_default();
        self.balances.set(&from, b.saturating_sub(amount));
        self.supply
            .set(self.supply.get_or_default().saturating_sub(amount));
    }
    pub fn approve(&mut self, spender: Address, amount: U256) {}
    pub fn transfer(&mut self, recipient: Address, amount: U256) {
        let from = self.env().caller();
        let fb = self.balances.get(&from).unwrap_or_default();
        self.balances.set(&from, fb.saturating_sub(amount));
        let rb = self.balances.get(&recipient).unwrap_or_default();
        self.balances.set(&recipient, rb + amount);
    }
    pub fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256) {
        let ob = self.balances.get(&owner).unwrap_or_default();
        self.balances.set(&owner, ob.saturating_sub(amount));
        let rb = self.balances.get(&recipient).unwrap_or_default();
        self.balances.set(&recipient, rb + amount);
    }
    pub fn balance_of(&self, address: Address) -> U256 {
        self.balances.get(&address).unwrap_or_default()
    }
    pub fn decimals(&self) -> u8 {
        self.decimals.get_or_default()
    }
    pub fn total_supply(&self) -> U256 {
        self.supply.get_or_default()
    }
}

// ------------------------------------------------ MockStaking (sCSPR token + Wise staking)

/// Mirrors the real Testnet shape where the sCSPR package is *both* the CEP-18 token and the
/// staking contract. `stake()` is payable and mints sCSPR 1:1 with attached CSPR (rate ≈ 1).
#[odra::module]
pub struct MockStaking {
    balances: Mapping<Address, U256>,
    supply: Var<U256>,
    staked: Var<U512>,
}

#[odra::module]
impl MockStaking {
    pub fn init(&mut self) {
        self.supply.set(U256::zero());
        self.staked.set(U512::zero());
    }

    #[odra(payable)]
    pub fn stake(&mut self) {
        let attached = self.env().attached_value();
        let minted = attached.to_u256().unwrap_or_default();
        let to = self.env().caller();
        let b = self.balances.get(&to).unwrap_or_default();
        self.balances.set(&to, b + minted);
        self.supply.set(self.supply.get_or_default() + minted);
        self.staked.set(self.staked.get_or_default() + attached);
    }
    pub fn unstake(&mut self, scspr_amount: U256) {
        let from = self.env().caller();
        let b = self.balances.get(&from).unwrap_or_default();
        self.balances.set(&from, b.saturating_sub(scspr_amount));
        self.supply
            .set(self.supply.get_or_default().saturating_sub(scspr_amount));
    }
    pub fn staked_cspr(&self) -> U512 {
        self.staked.get_or_default()
    }
    pub fn total_supply(&self) -> U256 {
        self.supply.get_or_default()
    }

    // CEP-18 + Mintable surface (sCSPR is also a token)
    pub fn mint(&mut self, to: Address, amount: U256) {
        let b = self.balances.get(&to).unwrap_or_default();
        self.balances.set(&to, b + amount);
        self.supply.set(self.supply.get_or_default() + amount);
        self.staked.set(self.staked.get_or_default() + amount.to_u512());
    }
    pub fn burn(&mut self, from: Address, amount: U256) {
        let b = self.balances.get(&from).unwrap_or_default();
        self.balances.set(&from, b.saturating_sub(amount));
        self.supply
            .set(self.supply.get_or_default().saturating_sub(amount));
        self.staked
            .set(self.staked.get_or_default().saturating_sub(amount.to_u512()));
    }
    pub fn approve(&mut self, spender: Address, amount: U256) {}
    pub fn transfer(&mut self, recipient: Address, amount: U256) {
        let from = self.env().caller();
        let fb = self.balances.get(&from).unwrap_or_default();
        self.balances.set(&from, fb.saturating_sub(amount));
        let rb = self.balances.get(&recipient).unwrap_or_default();
        self.balances.set(&recipient, rb + amount);
    }
    pub fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256) {
        let ob = self.balances.get(&owner).unwrap_or_default();
        self.balances.set(&owner, ob.saturating_sub(amount));
        let rb = self.balances.get(&recipient).unwrap_or_default();
        self.balances.set(&recipient, rb + amount);
    }
    pub fn balance_of(&self, address: Address) -> U256 {
        self.balances.get(&address).unwrap_or_default()
    }
    pub fn decimals(&self) -> u8 {
        9
    }
}

// ---------------------------------------------------------------- MockRouter (CSPR.trade)

/// Exact-in swap mock: burns `amount_in` of `path[0]` from `to`, mints a configurable
/// `out_amount` of `path[last]` to `to`. `get_amounts_out` reports a separate `quote_amount`
/// so tests can drive the on-chain slippage floor independently of realized output.
#[odra::module]
pub struct MockRouter {
    out_amount: Var<U256>,
    quote_amount: Var<U256>,
}

#[odra::module]
impl MockRouter {
    pub fn init(&mut self, out_amount: U256, quote_amount: U256) {
        self.out_amount.set(out_amount);
        self.quote_amount.set(quote_amount);
    }
    pub fn set_out(&mut self, out_amount: U256) {
        self.out_amount.set(out_amount);
    }
    pub fn set_quote(&mut self, quote_amount: U256) {
        self.quote_amount.set(quote_amount);
    }
    pub fn get_amounts_out(&self, amount_in: U256, path: Vec<Address>) -> Vec<U256> {
        vec![amount_in, self.quote_amount.get_or_default()]
    }
    pub fn swap_exact_tokens_for_tokens(
        &mut self,
        amount_in: U256,
        amount_out_min: U256,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<U256> {
        let token_in = path[0];
        let token_out = path[path.len() - 1];
        let out = self.out_amount.get_or_default();
        MintableContractRef::new(self.env(), token_in).burn(to, amount_in);
        MintableContractRef::new(self.env(), token_out).mint(to, out);
        vec![amount_in, out]
    }
}

// ---------------------------------------------------------------- MockStyks (price feed)

#[odra::module]
pub struct MockStyks {
    twap: Var<u64>,
    heartbeat: Var<u64>,
}

#[odra::module]
impl MockStyks {
    pub fn init(&mut self, twap: u64) {
        self.twap.set(twap);
        self.heartbeat.set(1);
    }
    pub fn set_twap(&mut self, twap: u64) {
        self.twap.set(twap);
    }
    pub fn get_twap_price(&self, id: String) -> Option<u64> {
        self.twap.get()
    }
    pub fn get_last_heartbeat(&self) -> Option<u64> {
        self.heartbeat.get()
    }
}
