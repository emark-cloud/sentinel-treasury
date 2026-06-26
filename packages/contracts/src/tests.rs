//! Guardrail + behavior tests (MockVM). One test per hard invariant (spec §11 / TODO Phase 2)
//! plus AuditLog append-only semantics, the stake/swap happy paths, and the multi-tenant
//! per-account model: per-user policy clamping, per-account isolation, and the load-bearing
//! `sum(account ledgers) == contract holdings` invariant. Mocks live in `crate::mocks`;
//! valuation uses a clean fixed TWAP so USD math is exact.

use odra::casper_types::{U256, U512};
use odra::host::{Deployer, HostRef, NoArgs};
use odra::prelude::*;

use crate::audit_log::{AuditLog, AuditLogHostRef, AuditLogInitArgs, Error as LogError};
use crate::mocks::{
    MockRouter, MockRouterHostRef, MockRouterInitArgs, MockStaking, MockStakingHostRef, MockStyks,
    MockStyksInitArgs, MockToken, MockTokenHostRef, MockTokenInitArgs,
};
use crate::types::{
    ActionKind, ActionResult, Asset, PolicyConfig, RebalanceParams, Receipt, Regime,
};
use crate::vault::{Error as VaultError, SentinelVault, SentinelVaultHostRef, SentinelVaultInitArgs};

/// 1 CSPR = 0.02 USD at the live-confirmed Styks scale (5 decimals, D-012) → 0.02 * 1e5.
const TWAP: u64 = 2_000;

fn cspr512(n: u64) -> U512 {
    U512::from(n) * U512::from(1_000_000_000u64)
}
fn cspr256(n: u64) -> U256 {
    U256::from(n) * U256::from(1_000_000_000u64)
}
/// Micro-USD (6 decimals), the unit caps are denominated in.
fn usd(n: u64) -> U256 {
    U256::from(n) * U256::from(1_000_000u64)
}

/// The owner envelope: the most-permissive policy any account may use.
fn generous_policy() -> PolicyConfig {
    PolicyConfig {
        per_action_cap_usd: usd(5), // $5 per action
        daily_cap_usd: usd(20),     // $20 per day
        max_slippage_bps: 100,      // 1%
        min_scspr_bps: 0,
        max_scspr_bps: 10_000,
    }
}

struct Fixture {
    env: odra::host::HostEnv,
    vault: SentinelVaultHostRef,
    audit: AuditLogHostRef,
    staking: MockStakingHostRef,
    wusdt: MockTokenHostRef,
    router: MockRouterHostRef,
    owner: Address,
    agent: Address,
    outsider: Address,
}

fn setup() -> Fixture {
    let env = odra_test::env();
    let owner = env.get_account(0);
    let agent = env.get_account(1);
    let outsider = env.get_account(2);

    let styks = MockStyks::deploy(&env, MockStyksInitArgs { twap: TWAP });
    let staking = MockStaking::deploy(&env, NoArgs);
    let wusdt = MockToken::deploy(&env, MockTokenInitArgs { decimals: 6 });
    let router = MockRouter::deploy(
        &env,
        MockRouterInitArgs {
            out_amount: U256::zero(),
            quote_amount: U256::zero(),
        },
    );

    let audit = AuditLog::deploy(&env, AuditLogInitArgs { admin: owner, agent });

    let vault = SentinelVault::deploy(
        &env,
        SentinelVaultInitArgs {
            owner,
            agent,
            audit_log: audit.address(),
            cfg: generous_policy(),
            styks: styks.address(),
            router: router.address(),
            scspr: staking.address(),
            wusdt: wusdt.address(),
        },
    );

    // Break the circular dependency: bind the vault into the AuditLog (owner-only), and seed the
    // owner account with 1000 CSPR (≈ $20) so stake legs have ledger funds to draw from.
    env.set_caller(owner);
    let mut audit = audit;
    audit.set_vault(vault.address());
    vault.with_tokens(cspr512(1_000)).deposit_cspr();

    Fixture {
        env,
        vault,
        audit,
        staking,
        wusdt,
        router,
        owner,
        agent,
        outsider,
    }
}

/// Build a `RebalanceParams` with zeroed proof hashes and a Calm regime (the tests exercise the
/// enforcement flow, not hashing — that is covered in `packages/shared`).
fn params(
    kind: ActionKind,
    asset: Asset,
    amount: U256,
    target: Address,
    min_out: U256,
    path: Vec<Address>,
) -> RebalanceParams {
    RebalanceParams {
        kind,
        asset,
        amount,
        target,
        min_out,
        path,
        perception_hash: [0u8; 32],
        decision_hash: [0u8; 32],
        regime: Regime::Calm,
    }
}

// ------------------------------------------------------------------ AuditLog

#[test]
fn audit_log_is_append_only_and_queryable() {
    let f = setup();
    let mut audit = f.audit;
    f.env.set_caller(f.agent); // the agent is an authorized writer

    for i in 0..3u64 {
        let mut r = sample_receipt(f.agent);
        r.action_id = i;
        audit.record(r);
    }
    assert_eq!(audit.count(), 3);
    assert_eq!(audit.get(1).unwrap().action_id, 1);
    assert!(audit.get(9).is_none());
    let latest = audit.latest(2);
    assert_eq!(latest.len(), 2);
    assert_eq!(latest[0].action_id, 1);
    assert_eq!(audit.range(0, 3).len(), 3);
}

#[test]
fn audit_log_record_rejects_unauthorized() {
    let f = setup();
    let mut audit = f.audit;
    f.env.set_caller(f.outsider);
    assert_eq!(
        audit.try_record(sample_receipt(f.outsider)),
        Err(LogError::Unauthorized.into())
    );
}

// ------------------------------------------------------------------ guardrails

#[test]
fn role_gate_blocks_non_agent() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.outsider);
    let p = params(
        ActionKind::Stake,
        Asset::Cspr,
        cspr256(100),
        f.staking.address(),
        U256::zero(),
        vec![],
    );
    assert_eq!(
        vault.try_execute_rebalance(f.owner, p),
        Err(VaultError::NotAgent.into())
    );
}

#[test]
fn pause_blocks_agent_action() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.owner);
    vault.pause(true);
    f.env.set_caller(f.agent);
    let p = params(
        ActionKind::Stake,
        Asset::Cspr,
        cspr256(100),
        f.staking.address(),
        U256::zero(),
        vec![],
    );
    assert_eq!(
        vault.try_execute_rebalance(f.owner, p),
        Err(VaultError::Paused.into())
    );
}

#[test]
fn non_whitelisted_target_reverts() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.agent);
    let p = params(
        ActionKind::Stake,
        Asset::Cspr,
        cspr256(100),
        f.outsider, // not whitelisted
        U256::zero(),
        vec![],
    );
    assert_eq!(
        vault.try_execute_rebalance(f.owner, p),
        Err(VaultError::TargetNotWhitelisted.into())
    );
}

#[test]
fn per_action_cap_breach_reverts() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.agent);
    // 300 CSPR ≈ $6 > $5 per-action cap.
    let p = params(
        ActionKind::Stake,
        Asset::Cspr,
        cspr256(300),
        f.staking.address(),
        U256::zero(),
        vec![],
    );
    assert_eq!(
        vault.try_execute_rebalance(f.owner, p),
        Err(VaultError::PerActionCapExceeded.into())
    );
}

#[test]
fn daily_cap_breach_reverts() {
    let f = setup();
    let mut vault = f.vault;
    // Loosen per-action but tighten the daily envelope to $3.
    f.env.set_caller(f.owner);
    vault.set_policy(PolicyConfig {
        per_action_cap_usd: usd(100),
        daily_cap_usd: usd(3),
        max_slippage_bps: 100,
        min_scspr_bps: 0,
        max_scspr_bps: 10_000,
    });
    f.env.set_caller(f.agent);
    // 200 CSPR ≈ $4 > $3 daily cap.
    let p = params(
        ActionKind::Stake,
        Asset::Cspr,
        cspr256(200),
        f.staking.address(),
        U256::zero(),
        vec![],
    );
    assert_eq!(
        vault.try_execute_rebalance(f.owner, p),
        Err(VaultError::DailyCapExceeded.into())
    );
}

#[test]
fn slippage_below_min_out_reverts() {
    let f = setup();
    let mut vault = f.vault;
    let mut staking = f.staking;
    let mut router = f.router;

    // Give the owner account 100 sCSPR to de-risk, and configure the router to under-deliver.
    staking.mint(f.owner, cspr256(100));
    f.env.set_caller(f.owner);
    vault.deposit_token(staking.address(), cspr256(100));
    router.set_quote(usd(2)); // healthy quote → high on-chain min_out floor
    router.set_out(U256::zero()); // realized output far below the floor

    f.env.set_caller(f.agent);
    let p = params(
        ActionKind::SwapToStable,
        Asset::Scspr,
        cspr256(100),
        router.address(),
        U256::zero(),
        vec![staking.address(), f.wusdt.address()],
    );
    assert_eq!(
        vault.try_execute_rebalance(f.owner, p),
        Err(VaultError::SlippageExceeded.into())
    );
}

#[test]
fn allocation_out_of_bounds_reverts() {
    let f = setup();
    let mut vault = f.vault;
    // Cap sCSPR allocation at 1%; a 100-CSPR stake lands the owner account at ~10% sCSPR.
    f.env.set_caller(f.owner);
    vault.set_policy(PolicyConfig {
        per_action_cap_usd: usd(100),
        daily_cap_usd: usd(100),
        max_slippage_bps: 100,
        min_scspr_bps: 0,
        max_scspr_bps: 100,
    });
    f.env.set_caller(f.agent);
    let p = params(
        ActionKind::Stake,
        Asset::Cspr,
        cspr256(100),
        f.staking.address(),
        U256::zero(),
        vec![],
    );
    assert_eq!(
        vault.try_execute_rebalance(f.owner, p),
        Err(VaultError::AllocationOutOfBounds.into())
    );
}

#[test]
fn insufficient_account_funds_reverts() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.agent);
    // The outsider has no ledger funds; staking 100 CSPR on their behalf must revert.
    let p = params(
        ActionKind::Stake,
        Asset::Cspr,
        cspr256(100),
        f.staking.address(),
        U256::zero(),
        vec![],
    );
    assert_eq!(
        vault.try_execute_rebalance(f.outsider, p),
        Err(VaultError::InsufficientAccountFunds.into())
    );
}

// ------------------------------------------------------------------ happy paths

#[test]
fn stake_happy_path_records_receipt() {
    let f = setup();
    let mut vault = f.vault;
    let audit = f.audit;
    f.env.set_caller(f.agent);

    let result = vault.execute_rebalance(
        f.owner,
        params(
            ActionKind::Stake,
            Asset::Cspr,
            cspr256(100),
            f.staking.address(),
            U256::zero(),
            vec![],
        ),
    );
    assert_eq!(result, ActionResult::Success);

    // sCSPR minted 1:1 into the vault and credited to the owner's ledger; nonce up; proof appended.
    assert_eq!(f.staking.balance_of(vault.address()), cspr256(100));
    assert_eq!(vault.account_balances(f.owner).scspr, cspr256(100));
    assert_eq!(vault.account_balances(f.owner).cspr, cspr512(900));
    assert_eq!(vault.nonce(), 1);
    assert_eq!(audit.count(), 1);

    let r = audit.get(0).unwrap();
    assert_eq!(r.action_kind, ActionKind::Stake);
    assert_eq!(r.account, f.owner);
    assert_eq!(r.notional_usd, usd(2));
    assert_eq!(r.result, ActionResult::Success);
    assert_eq!(r.cspr_usd_twap, U256::from(TWAP));

    // $2 of the owner's $20 daily spent.
    assert_eq!(vault.day_remaining_usd(f.owner), usd(18));
}

#[test]
fn swap_de_risk_happy_path() {
    let f = setup();
    let mut vault = f.vault;
    let mut staking = f.staking;
    let mut router = f.router;

    staking.mint(f.owner, cspr256(200));
    f.env.set_caller(f.owner);
    vault.deposit_token(staking.address(), cspr256(200));
    router.set_quote(usd(2));
    router.set_out(usd(2)); // 100 sCSPR → 2 WUSDT

    f.env.set_caller(f.agent);
    let result = vault.execute_rebalance(
        f.owner,
        params(
            ActionKind::SwapToStable,
            Asset::Scspr,
            cspr256(100),
            router.address(),
            U256::zero(),
            vec![staking.address(), f.wusdt.address()],
        ),
    );
    assert_eq!(result, ActionResult::Success);
    // Contract holdings and the owner's ledger both reflect the swap.
    assert_eq!(staking.balance_of(vault.address()), cspr256(100)); // 200 - 100 burned
    assert_eq!(f.wusdt.balance_of(vault.address()), usd(2)); // minted out
    assert_eq!(vault.account_balances(f.owner).scspr, cspr256(100));
    assert_eq!(vault.account_balances(f.owner).csprusd, usd(2));
    assert_eq!(f.audit.count(), 1);
}

#[test]
fn owner_can_pause_and_unpause() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.owner);
    vault.pause(true);
    assert!(vault.is_paused());
    vault.pause(false);
    assert!(!vault.is_paused());
}

#[test]
fn set_policy_is_owner_only() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.outsider);
    assert_eq!(
        vault.try_set_policy(generous_policy()),
        Err(VaultError::NotOwner.into())
    );
}

// ------------------------------------------------------------------ depositor ledger (per-account)

#[test]
fn deposit_credits_the_depositors_own_ledger() {
    let f = setup();
    // setup() deposited 1000 CSPR (≈ $20 at TWAP) as the owner.
    assert_eq!(f.vault.account_balances(f.owner).cspr, cspr512(1_000));
    assert_eq!(f.vault.account_value_usd(f.owner), usd(20));
    // A fresh account starts empty.
    assert_eq!(f.vault.account_balances(f.outsider).cspr, U512::zero());
    assert_eq!(f.vault.account_value_usd(f.outsider), U256::zero());
}

#[test]
fn accounts_are_isolated() {
    let f = setup();
    let vault = f.vault;
    f.env.set_caller(f.outsider);
    vault.with_tokens(cspr512(500)).deposit_cspr();
    // Each account sees only its own funds; the aggregate is the sum.
    assert_eq!(vault.account_balances(f.owner).cspr, cspr512(1_000));
    assert_eq!(vault.account_balances(f.outsider).cspr, cspr512(500));
    assert_eq!(vault.balances().cspr, cspr512(1_500));
}

#[test]
fn withdraw_pays_out_own_funds() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.owner);
    vault.withdraw(Asset::Cspr, cspr256(400));
    assert_eq!(vault.account_balances(f.owner).cspr, cspr512(600));
    assert_eq!(vault.balances().cspr, cspr512(600));
}

#[test]
fn redeem_full_exit_pays_in_kind() {
    let f = setup();
    let mut vault = f.vault;
    let mut staking = f.staking;
    let mut wusdt = f.wusdt;

    // Owner book: 1000 CSPR (from setup) + 200 sCSPR + 8 WUSDT.
    staking.mint(f.owner, cspr256(200));
    f.env.set_caller(f.owner);
    vault.deposit_token(staking.address(), cspr256(200));
    wusdt.mint(f.owner, usd(8));
    f.env.set_caller(f.owner);
    vault.deposit_token(wusdt.address(), usd(8));

    f.env.set_caller(f.owner);
    vault.redeem();

    // Ledger zeroed; the redeemer holds the tokens; the vault is drained of the owner's slice.
    assert_eq!(vault.account_balances(f.owner).cspr, U512::zero());
    assert_eq!(vault.account_balances(f.owner).scspr, U256::zero());
    assert_eq!(vault.account_balances(f.owner).csprusd, U256::zero());
    assert_eq!(staking.balance_of(f.owner), cspr256(200));
    assert_eq!(wusdt.balance_of(f.owner), usd(8));
    assert_eq!(staking.balance_of(vault.address()), U256::zero());
    assert_eq!(wusdt.balance_of(vault.address()), U256::zero());
}

#[test]
fn withdraw_rejects_overdraw() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.outsider); // holds nothing
    assert_eq!(
        vault.try_withdraw(Asset::Cspr, cspr256(1)),
        Err(VaultError::InsufficientAccountFunds.into())
    );
}

#[test]
fn deposits_do_not_consume_the_daily_cap() {
    let f = setup();
    let vault = f.vault;
    f.env.set_caller(f.outsider);
    vault.with_tokens(cspr512(2_000)).deposit_cspr();
    assert_eq!(vault.day_remaining_usd(f.outsider), usd(20)); // full daily cap still available
}

// ------------------------------------------------------------------ per-user guardrails

#[test]
fn user_policy_is_clamped_to_the_owner_envelope() {
    let f = setup();
    let mut vault = f.vault;
    // The user tries to *widen* past the envelope ($5 / $20 / 1% / band 0–100%).
    f.env.set_caller(f.outsider);
    vault.set_my_policy(PolicyConfig {
        per_action_cap_usd: usd(1_000), // > envelope $5
        daily_cap_usd: usd(1_000),      // > envelope $20
        max_slippage_bps: 5_000,        // > envelope 1%
        min_scspr_bps: 2_000,           // tighter floor (allowed)
        max_scspr_bps: 6_000,           // tighter ceiling (allowed)
    });
    let eff = vault.account_policy(f.outsider);
    assert_eq!(eff.per_action_cap_usd, usd(5)); // clamped down to envelope
    assert_eq!(eff.daily_cap_usd, usd(20)); // clamped down
    assert_eq!(eff.max_slippage_bps, 100); // clamped down
    assert_eq!(eff.min_scspr_bps, 2_000); // user's tighter floor kept
    assert_eq!(eff.max_scspr_bps, 6_000); // user's tighter ceiling kept
}

#[test]
fn user_can_tighten_below_their_own_cap() {
    let f = setup();
    let mut vault = f.vault;
    // The owner account sets its *own* per-action cap to $1 — tighter than the $5 envelope.
    f.env.set_caller(f.owner);
    vault.set_my_policy(PolicyConfig {
        per_action_cap_usd: usd(1),
        daily_cap_usd: usd(20),
        max_slippage_bps: 100,
        min_scspr_bps: 0,
        max_scspr_bps: 10_000,
    });
    // A 100-CSPR ($2) stake now breaches the *account's own* $1 cap, though the envelope is $5.
    f.env.set_caller(f.agent);
    let p = params(
        ActionKind::Stake,
        Asset::Cspr,
        cspr256(100),
        f.staking.address(),
        U256::zero(),
        vec![],
    );
    assert_eq!(
        vault.try_execute_rebalance(f.owner, p),
        Err(VaultError::PerActionCapExceeded.into())
    );
}

#[test]
fn malformed_user_policy_reverts() {
    let f = setup();
    let mut vault = f.vault;
    f.env.set_caller(f.outsider);
    // Inverted band (min > max) is rejected at set time.
    assert_eq!(
        vault.try_set_my_policy(PolicyConfig {
            per_action_cap_usd: usd(1),
            daily_cap_usd: usd(1),
            max_slippage_bps: 100,
            min_scspr_bps: 8_000,
            max_scspr_bps: 2_000,
        }),
        Err(VaultError::InvalidPolicy.into())
    );
}

// ------------------------------------------------------------------ the sum invariant

/// The load-bearing multi-tenant property: across deposits, a rebalance, and a redeem, the
/// contract's *actual* holdings always equal the sum of the per-account ledgers. Verified over the
/// three accounts the test touches (Mappings aren't enumerable on-chain; the off-chain indexer
/// tracks the live account set from `Deposited` events).
#[test]
fn ledger_sums_equal_contract_holdings() {
    let f = setup();
    let mut vault = f.vault;
    let mut staking = f.staking;
    let mut router = f.router;
    let accounts = [f.owner, f.outsider, f.agent];

    // Two depositors + a managed-token deposit, then an agent rebalance of one account's slice.
    f.env.set_caller(f.outsider);
    vault.with_tokens(cspr512(500)).deposit_cspr();
    staking.mint(f.owner, cspr256(300));
    f.env.set_caller(f.owner);
    vault.deposit_token(staking.address(), cspr256(300));

    router.set_quote(usd(4));
    router.set_out(usd(4)); // 200 sCSPR → 4 WUSDT
    f.env.set_caller(f.agent);
    vault.execute_rebalance(
        f.owner,
        params(
            ActionKind::SwapToStable,
            Asset::Scspr,
            cspr256(200),
            router.address(),
            U256::zero(),
            vec![staking.address(), f.wusdt.address()],
        ),
    );
    assert_invariant(&vault, &accounts);

    // A full redeem must also keep the books balanced.
    f.env.set_caller(f.outsider);
    vault.redeem();
    assert_invariant(&vault, &accounts);
}

fn assert_invariant(vault: &SentinelVaultHostRef, accounts: &[Address]) {
    let mut sum_cspr = U512::zero();
    let mut sum_scspr = U256::zero();
    let mut sum_csprusd = U256::zero();
    for a in accounts {
        let b = vault.account_balances(*a);
        sum_cspr += b.cspr;
        sum_scspr += b.scspr;
        sum_csprusd += b.csprusd;
    }
    let held = vault.balances();
    assert_eq!(sum_cspr, held.cspr, "native CSPR ledger sum != holdings");
    assert_eq!(sum_scspr, held.scspr, "sCSPR ledger sum != holdings");
    assert_eq!(sum_csprusd, held.csprusd, "stable ledger sum != holdings");
}

// ------------------------------------------------------------------ helpers

fn sample_receipt(addr: Address) -> Receipt {
    use crate::types::AllocationBps;
    let alloc = AllocationBps {
        scspr: 6000,
        csprusd: 4000,
        cspr: 0,
    };
    Receipt {
        action_id: 0,
        timestamp: 0,
        agent: addr,
        account: addr,
        action_kind: ActionKind::NoOp,
        regime: Regime::Calm,
        perception_hash: [0u8; 32],
        decision_hash: [0u8; 32],
        pre_alloc_bps: alloc.clone(),
        post_alloc_bps: alloc,
        amount: U256::zero(),
        notional_usd: U256::zero(),
        target: addr,
        deploy_hash: [0u8; 32],
        result: ActionResult::Skipped,
        cspr_usd_twap: U256::zero(),
    }
}
