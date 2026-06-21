//! Associated-keys hardening for the Sentinel agent account (spec §4.3) — one-shot session code.
//!
//! Run **as session code from the agent account, signed by the agent key**, while its
//! key-management threshold is still the default 1. The whole thing is atomic: if any step
//! reverts, no change is committed, so there is no window in which the account can be locked.
//!
//! After it succeeds the agent account holds two associated keys —
//!   agent key (weight 1, signs `execute_rebalance`) + owner key (weight 3, recovery/key-mgmt)
//! — with `deployment_threshold = 1` and `key_management_threshold = 3`. Net effect: the agent
//! can transact but **cannot rekey, escalate, or manage keys**; the owner retains unilateral
//! recovery.
//!
//! The owner account hash is embedded (verified to match `OWNER_PUBLIC_KEY` via
//! `casper-client account-address`) so no runtime arg can misdirect the weight-3 key.

#![no_std]
#![no_main]

extern crate alloc;

use casper_contract::contract_api::account;
use casper_contract::unwrap_or_revert::UnwrapOrRevert;
use casper_types::account::{AccountHash, ActionType, Weight};

// no-std-helpers is off (see Cargo.toml), so provide the allocator + panic handler ourselves.
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Owner account hash (`account-hash-bab4ee7d…df4b7`) derived from `OWNER_PUBLIC_KEY`.
const OWNER_ACCOUNT_HASH: [u8; 32] = [
    0xba, 0xb4, 0xee, 0x7d, 0x94, 0x94, 0x5b, 0xdc, 0xe5, 0xb0, 0x92, 0x7a, 0xa1, 0xa6, 0x6b, 0xf0,
    0xd3, 0xa2, 0x06, 0xde, 0xbe, 0x96, 0x26, 0x70, 0x24, 0x03, 0xe7, 0xeb, 0x97, 0x8d, 0xf4, 0xb7,
];

#[no_mangle]
pub extern "C" fn call() {
    let owner = AccountHash::new(OWNER_ACCOUNT_HASH);

    // 1. Add the owner key at weight 3 *before* raising the key-management threshold, so the new
    //    threshold is always reachable (owner w3 + agent w1 = total weight 4).
    account::add_associated_key(owner, Weight::new(3)).unwrap_or_revert();

    // 2. Only weight >= 3 may manage keys (agent's w1 can no longer rekey/escalate).
    account::set_action_threshold(ActionType::KeyManagement, Weight::new(3)).unwrap_or_revert();

    // 3. Weight >= 1 may send deploys, so the agent key alone still signs execute_rebalance.
    account::set_action_threshold(ActionType::Deployment, Weight::new(1)).unwrap_or_revert();
}
