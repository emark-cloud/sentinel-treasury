//! Testnet deploy for Sentinel Treasury (Phase 2, D-008 order: AuditLog → Vault → set_vault).
//!
//! Run from `packages/contracts` with the repo `.env` sourced and the Livenet env vars set
//! (see `docs/deploy-runbook.md`):
//!
//! ```bash
//! cargo run --bin livenet_deploy --features livenet
//! ```
//!
//! Account 0 (`ODRA_CASPER_LIVENET_SECRET_KEY_PATH`) is the **owner**; account 1
//! (`ODRA_CASPER_LIVENET_KEY_1`) is the bounded **agent**. The vault initializes with the
//! conservative demo policy (per-action $50 / daily $200, sCSPR band 15–70%, slippage 1%).

use odra::casper_types::U256;
use core::str::FromStr;

use odra::host::{Deployer, InstallConfig};
use odra::prelude::{Address, Addressable};

use sentinel_contracts::audit_log::{AuditLog, AuditLogHostRef, AuditLogInitArgs};
use sentinel_contracts::types::PolicyConfig;
use sentinel_contracts::vault::{SentinelVault, SentinelVaultHostRef, SentinelVaultInitArgs};

/// Parse a raw 64-hex contract package hash (as stored in `.env`) into an Odra contract `Address`.
/// Odra wraps contracts as `Key::Hash`, i.e. the `hash-` prefix (not `package-`).
fn contract_addr(hex: &str) -> Address {
    Address::from_str(&format!("hash-{}", hex.trim()))
        .unwrap_or_else(|_| panic!("invalid contract hash: {hex}"))
}

/// Read a required raw-hex contract hash from the environment.
fn env_contract(key: &str) -> Address {
    let hex = std::env::var(key).unwrap_or_else(|_| panic!("missing env var {key}"));
    contract_addr(&hex)
}

fn main() {
    let env = odra_casper_livenet_env::env();

    let owner = env.caller();
    let agent = env.get_account(1);

    // External Testnet targets (Mode A): Styks oracle, CSPR.trade router, Wise staking (= sCSPR
    // token), WUSDT stable. Sourced from the repo `.env` contract-hash registry.
    let styks = env_contract("STYKS_PRICE_FEED_HASH");
    let router = env_contract("CSPR_TRADE_ROUTER_HASH");
    let scspr = env_contract("WISE_LENDING_STAKING_HASH");
    let wusdt = env_contract("STABLE_TOKEN_HASH");

    // Conservative demo guardrail policy. USD caps are micro-USD (USD × 10^6); bps in [0, 10000].
    let policy = PolicyConfig {
        per_action_cap_usd: U256::from(50_000_000u64), // $50
        daily_cap_usd: U256::from(200_000_000u64),     // $200
        max_slippage_bps: 100,                         // 1.00%
        min_scspr_bps: 1_500,                          // 15%
        max_scspr_bps: 7_000,                          // 70%
    };

    println!("== Sentinel Treasury deploy (casper-test) ==");
    println!("owner = {}", owner.to_string());
    println!("agent = {}", agent.to_string());

    // 1. AuditLog. admin = owner (binds the vault below); agent is an authorized writer from init.
    // Deployed UPGRADABLE (InstallConfig::upgradable) — the plain `deploy()` installs a *Locked*
    // Casper package (is_upgradable=false), which is what stranded the first deploy: D-013's scale
    // fix could not be pushed as an in-place upgrade. Upgradable packages accept new versions.
    env.set_gas(250_000_000_000u64); // 250 CSPR
    let mut audit_log = AuditLog::deploy_with_cfg(
        &env,
        AuditLogInitArgs { admin: owner, agent },
        InstallConfig::upgradable::<AuditLogHostRef>(),
    );
    let audit_log_addr = audit_log.address();
    println!("AUDITLOG_CONTRACT_HASH={}", audit_log_addr.to_string());

    // 2. SentinelVault. Pre-whitelists router + sCSPR staking as the only legal action targets.
    env.set_gas(400_000_000_000u64); // 400 CSPR
    let vault = SentinelVault::deploy_with_cfg(
        &env,
        SentinelVaultInitArgs {
            owner,
            agent,
            audit_log: audit_log_addr,
            cfg: policy,
            styks,
            router,
            scspr,
            wusdt,
        },
        InstallConfig::upgradable::<SentinelVaultHostRef>(),
    );
    let vault_addr = vault.address();
    println!("VAULT_CONTRACT_HASH={}", vault_addr.to_string());

    // 3. Bind the vault as the AuditLog's cross-contract writer (admin-only, one-time — D-008).
    env.set_gas(20_000_000_000u64); // 20 CSPR
    audit_log.set_vault(vault_addr);
    println!("set_vault: bound vault {} as AuditLog writer", vault_addr.to_string());

    println!("== deploy complete — record the two *_CONTRACT_HASH values above in .env / CLAUDE.md ==");
}
