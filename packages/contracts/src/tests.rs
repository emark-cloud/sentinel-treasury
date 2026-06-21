//! Guardrail + behavior tests (MockVM). One test per hard invariant (spec §11 / TODO Phase 2)
//! plus AuditLog append-only semantics and the stake/swap happy paths. Mocks live in
//! `crate::mocks`; valuation uses a clean fixed TWAP so USD math is exact.

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

/// 1 CSPR = 0.02 USD, Styks U64 scaled by 10^9 → 0.02 * 1e9.
const TWAP: u64 = 20_000_000;

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

fn generous_policy() -> PolicyConfig {
    PolicyConfig {
        per_action_cap_usd: usd(5),   // $5 per action
        daily_cap_usd: usd(20),       // $20 per day
        max_slippage_bps: 100,        // 1%
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

    // Break the circular dependency: bind the vault into the AuditLog (owner-only), and fund
    // the vault with CSPR so stake legs have a purse to draw from.
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
    assert_eq!(vault.try_execute_rebalance(p), Err(VaultError::NotAgent.into()));
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
    assert_eq!(vault.try_execute_rebalance(p), Err(VaultError::Paused.into()));
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
        vault.try_execute_rebalance(p),
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
        vault.try_execute_rebalance(p),
        Err(VaultError::PerActionCapExceeded.into())
    );
}

#[test]
fn daily_cap_breach_reverts() {
    let f = setup();
    let mut vault = f.vault;
    // Loosen per-action but tighten the daily cap to $3.
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
        vault.try_execute_rebalance(p),
        Err(VaultError::DailyCapExceeded.into())
    );
}

#[test]
fn slippage_below_min_out_reverts() {
    let f = setup();
    let mut vault = f.vault;
    let mut staking = f.staking;
    let mut router = f.router;

    // Seed the vault with sCSPR to de-risk, and configure the router to under-deliver.
    staking.mint(vault.address(), cspr256(100));
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
        vault.try_execute_rebalance(p),
        Err(VaultError::SlippageExceeded.into())
    );
}

#[test]
fn allocation_out_of_bounds_reverts() {
    let f = setup();
    let mut vault = f.vault;
    // Cap sCSPR allocation at 1%; a 100-CSPR stake lands the vault at ~10% sCSPR.
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
        vault.try_execute_rebalance(p),
        Err(VaultError::AllocationOutOfBounds.into())
    );
}

// ------------------------------------------------------------------ happy paths

#[test]
fn stake_happy_path_records_receipt() {
    let f = setup();
    let mut vault = f.vault;
    let audit = f.audit;
    f.env.set_caller(f.agent);

    let result = vault.execute_rebalance(params(
        ActionKind::Stake,
        Asset::Cspr,
        cspr256(100),
        f.staking.address(),
        U256::zero(),
        vec![],
    ));
    assert_eq!(result, ActionResult::Success);

    // sCSPR minted 1:1 into the vault; nonce advanced; proof appended.
    assert_eq!(f.staking.balance_of(vault.address()), cspr256(100));
    assert_eq!(vault.nonce(), 1);
    assert_eq!(audit.count(), 1);

    let r = audit.get(0).unwrap();
    assert_eq!(r.action_kind, ActionKind::Stake);
    assert_eq!(r.notional_usd, usd(2));
    assert_eq!(r.result, ActionResult::Success);
    assert_eq!(r.cspr_usd_twap, U256::from(TWAP));

    // $2 of $20 daily spent.
    assert_eq!(vault.day_remaining_usd(), usd(18));
}

#[test]
fn swap_de_risk_happy_path() {
    let f = setup();
    let mut vault = f.vault;
    let mut staking = f.staking;
    let mut router = f.router;

    staking.mint(vault.address(), cspr256(200));
    router.set_quote(usd(2));
    router.set_out(usd(2)); // 100 sCSPR → 2 WUSDT

    f.env.set_caller(f.agent);
    let result = vault.execute_rebalance(params(
        ActionKind::SwapToStable,
        Asset::Scspr,
        cspr256(100),
        router.address(),
        U256::zero(),
        vec![staking.address(), f.wusdt.address()],
    ));
    assert_eq!(result, ActionResult::Success);
    assert_eq!(staking.balance_of(vault.address()), cspr256(100)); // 200 - 100 burned
    assert_eq!(f.wusdt.balance_of(vault.address()), usd(2)); // minted out
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
