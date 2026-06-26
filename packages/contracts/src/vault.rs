//! SentinelVault — multi-tenant custody boundary + per-account policy enforcement + the bounded
//! autonomous action (spec §4.1). This is where the hard invariants live *below the agent's
//! reach*: a fully compromised agent brain still cannot exceed an account's USD caps, touch a
//! non-whitelisted target, breach the slippage floor, push an account's allocation out of its
//! band, or act while paused (spec §11).
//!
//! **Multi-tenant model.** One deployment serves many depositors. Each account owns its own
//! ledger slice (`cspr`/`scspr`/`csprusd`) and its own [`PolicyConfig`]; the agent rebalances
//! one account at a time within *that account's* guardrails. Tokens are commingled in the
//! contract but attributed per account — the load-bearing invariant is
//! **`sum(account balances) == the contract's actual holdings`**, preserved by crediting every
//! action's result from the *measured* contract balance delta (never an assumed amount).
//!
//! **Per-user guardrails within an owner envelope.** The owner sets a single global envelope (the
//! most-permissive policy allowed). A user may set their *own* policy with `set_my_policy`, but it
//! is clamped to the envelope at read time — a user can only *tighten*, never widen past the
//! owner's ceiling. So the owner's caps remain the hard floor of protection.
//!
//! Execution is **Mode A** (D-001): `execute_rebalance` makes the swap/stake cross-contract calls
//! itself and records the proof receipt to the AuditLog atomically.

use odra::casper_types::U256;
use odra::prelude::*;
use odra::uints::{ToU256, ToU512};
use odra::ContractRef;

use crate::audit_log::AuditLogContractRef;
use crate::external::{
    Cep18ContractRef, RouterContractRef, StakingContractRef, StyksPriceFeedContractRef,
};
use crate::types::{
    ActionKind, ActionResult, AllocationBps, Asset, PolicyConfig, RebalanceParams, Receipt,
    VaultBalances,
};

// --- Valuation scaling (confirmed against a live Styks read — D-012; centralized here) ---

/// Decimals of native CSPR / sCSPR base units (motes).
const CSPR_DECIMALS: u32 = 9;
/// Decimals of the Styks `get_twap_price` U64 fixed-point USD-per-CSPR value. **Confirmed = 5** by
/// a live Testnet read (D-012): raw CSPRUSD ≈ 307 against a live CSPR/USD ≈ $0.0023 ⇒ raw/1e5 ≈
/// $0.00307 (the nearest clean power-of-ten; 4 ⇒ 10× high, 6 ⇒ 10× low). All USD cap math keys
/// off this constant, so it must match the feed: the earlier value (9) under-valued notional by
/// ~10⁴×, which would have made the per-action/daily USD caps effectively non-binding.
pub const STYKS_TWAP_DECIMALS: u32 = 5;
/// Decimals of the USD unit caps are denominated in (micro-USD), matching the 6-decimal stable.
const USD_DECIMALS: u32 = 6;
/// The Styks TWAP series id we read for CSPR→USD.
const TWAP_ID: &str = "CSPRUSD";
/// Swap deadline window added to the current block time (ms): 20 minutes.
const SWAP_DEADLINE_MS: u64 = 20 * 60 * 1000;
/// Seconds in a UTC day — the rolling daily-cap bucket width.
const SECONDS_PER_DAY: u64 = 86_400;
/// Basis-point denominator.
const BPS: u64 = 10_000;

#[odra::odra_error]
pub enum Error {
    /// Caller is not the owner.
    NotOwner = 1,
    /// Caller is not the bounded agent.
    NotAgent = 2,
    /// Vault is paused (owner kill switch).
    Paused = 3,
    /// Action target is not whitelisted.
    TargetNotWhitelisted = 4,
    /// Per-action USD notional cap exceeded.
    PerActionCapExceeded = 5,
    /// Daily USD notional cap exceeded.
    DailyCapExceeded = 6,
    /// Resulting sCSPR allocation outside `[min_scspr_bps, max_scspr_bps]`.
    AllocationOutOfBounds = 7,
    /// Realized swap output below the enforced `min_out` (slippage ceiling).
    SlippageExceeded = 8,
    /// Styks TWAP unreadable / no price for the id.
    OracleUnavailable = 9,
    /// Swap action carried an empty/invalid route.
    InvalidPath = 10,
    /// Action asset/kind combination is not legal.
    InvalidAction = 11,
    /// Vault not initialized.
    NotInitialized = 12,
    /// Withdrawal/transfer amount exceeds available balance.
    InsufficientBalance = 13,
    /// Action amount exceeds the named account's ledger balance for the input asset.
    InsufficientAccountFunds = 14,
    /// A user-supplied policy is malformed (band inverted or bps out of range).
    InvalidPolicy = 15,
}

#[odra::module(
    errors = Error,
    events = [RebalanceExecuted, PolicyUpdated, AccountPolicySet, PausedSet, Deposited, Withdrawn, Redeemed]
)]
pub struct SentinelVault {
    // identity / control
    owner: Var<Address>,
    agent: Var<Address>,
    paused: Var<bool>,

    // global guardrail envelope (owner-settable) — the most-permissive policy any account may use.
    // Per-account policies are clamped to these at read time, so a user can only tighten.
    per_action_cap_usd: Var<U256>,
    daily_cap_usd: Var<U256>,
    max_slippage_bps: Var<u32>,
    min_scspr_bps: Var<u32>,
    max_scspr_bps: Var<u32>,
    whitelist: Mapping<Address, bool>,

    // accounting / wiring
    audit_log: Var<Address>,
    action_nonce: Var<u64>,

    // --- per-account ledger (multi-tenant). Each depositor's pro-rata claim is *explicit*: their
    // base-unit holdings of each bucket. The contract's real token balances equal the column sums.
    cspr_of: Mapping<Address, U256>,    // native CSPR (motes) credited to the account
    scspr_of: Mapping<Address, U256>,   // sCSPR (CEP-18 base units)
    csprusd_of: Mapping<Address, U256>, // stable (WUSDT, micro-USD)

    // --- per-account policy + per-account daily-cap bucket
    policy_of: Mapping<Address, PolicyConfig>,
    has_policy: Mapping<Address, bool>,
    day_spent_of: Mapping<Address, U256>,
    day_epoch_of: Mapping<Address, u64>,

    // protocol + asset addresses (Mode A targets; sCSPR token == Wise staking package)
    styks: Var<Address>,
    router: Var<Address>,
    scspr: Var<Address>,
    wusdt: Var<Address>,
}

#[odra::event]
pub struct RebalanceExecuted {
    pub nonce: u64,
    /// The account whose ledger slice moved.
    pub account: Address,
    pub action_kind: ActionKind,
    pub amount: U256,
    pub amount_out: U256,
    pub notional_usd: U256,
    pub target: Address,
    pub result: ActionResult,
}

#[odra::event]
pub struct PolicyUpdated {
    pub per_action_cap_usd: U256,
    pub daily_cap_usd: U256,
}

#[odra::event]
pub struct AccountPolicySet {
    pub account: Address,
    // Flattened scalars (not the nested `PolicyConfig`): embedding an `odra_type` struct in an
    // event fails CES serialization at runtime. The off-chain indexer reconstructs the policy from
    // these, or reads the authoritative value back via `account_policy`.
    pub per_action_cap_usd: U256,
    pub daily_cap_usd: U256,
    pub max_slippage_bps: u32,
    pub min_scspr_bps: u32,
    pub max_scspr_bps: u32,
}

#[odra::event]
pub struct PausedSet {
    pub paused: bool,
}

#[odra::event]
pub struct Deposited {
    /// Account that funded the vault; the deposit is credited to *its own* ledger slice.
    pub depositor: Address,
    /// `None` ⇒ native CSPR; otherwise the CEP-18 token deposited.
    pub token: Option<Address>,
    /// Base-unit amount deposited (and credited to the depositor's ledger).
    pub amount: U256,
}

#[odra::event]
pub struct Withdrawn {
    /// Account that pulled its own funds out.
    pub account: Address,
    pub token: Option<Address>,
    pub amount: U256,
}

#[odra::event]
pub struct Redeemed {
    /// Account that fully exited; received its entire in-kind ledger slice.
    pub redeemer: Address,
    pub cspr_out: U256,
    pub scspr_out: U256,
    pub csprusd_out: U256,
}

#[odra::module]
impl SentinelVault {
    // ------------------------------------------------------------------ owner surface

    /// Wire identities, the AuditLog, the global policy envelope, and the protocol/asset
    /// addresses. The router and staking package are pre-whitelisted as the only legal action
    /// targets; the owner can adjust the whitelist later.
    #[allow(clippy::too_many_arguments)]
    pub fn init(
        &mut self,
        owner: Address,
        agent: Address,
        audit_log: Address,
        cfg: PolicyConfig,
        styks: Address,
        router: Address,
        scspr: Address,
        wusdt: Address,
    ) {
        self.owner.set(owner);
        self.agent.set(agent);
        self.audit_log.set(audit_log);
        self.paused.set(false);
        self.action_nonce.set(0);
        self.write_policy(cfg);

        self.styks.set(styks);
        self.router.set(router);
        self.scspr.set(scspr);
        self.wusdt.set(wusdt);
        // Pre-whitelist the two legal targets (router for swaps, staking for stake/unstake).
        self.whitelist.set(&router, true);
        self.whitelist.set(&scspr, true);
    }

    /// Receive native CSPR and credit it to the depositor's *own* ledger slice. No shares, no
    /// pooling, no NAV math: your CSPR lands as your CSPR, and you decide (or your guardrails let
    /// the agent decide) what happens next.
    #[odra(payable)]
    pub fn deposit_cspr(&mut self) {
        let depositor = self.env().caller();
        let amount = self.env().attached_value().to_u256().unwrap_or_default();
        self.credit(&Asset::Cspr, depositor, amount);
        self.env().emit_event(Deposited {
            depositor,
            token: None,
            amount,
        });
    }

    /// Pull `amount` of a managed CEP-18 token into the vault (depositor must have approved the
    /// vault) and credit it to the depositor's ledger. Only the two managed assets (sCSPR, stable)
    /// are accepted — anything else has no defined ledger bucket and reverts.
    pub fn deposit_token(&mut self, token: Address, amount: U256) {
        let depositor = self.env().caller();
        let asset = if token == self.scspr_addr() {
            Asset::Scspr
        } else if token == self.wusdt_addr() {
            Asset::Csprusd
        } else {
            self.env().revert(Error::InvalidAction)
        };
        let me = self.env().self_address();
        Cep18ContractRef::new(self.env(), token).transfer_from(depositor, me, amount);
        self.credit(&asset, depositor, amount);
        self.env().emit_event(Deposited {
            depositor,
            token: Some(token),
            amount,
        });
    }

    /// Withdraw `amount` of one asset from the caller's *own* ledger slice (in-kind). For sCSPR
    /// this returns the token directly — the holder may keep it, unstake (≈16h unbonding → CSPR),
    /// or sell it on the DEX (instant, slippage). The choice stays with the user.
    pub fn withdraw(&mut self, asset: Asset, amount: U256) {
        let who = self.env().caller();
        self.require_funds(&asset, who, amount);
        self.debit(&asset, who, amount);
        let token = self.payout(&asset, who, amount);
        self.env().emit_event(Withdrawn {
            account: who,
            token,
            amount,
        });
    }

    /// Full exit: pay out the caller's entire in-kind ledger slice across all three buckets and
    /// zero their ledger. Balances are zeroed *before* any transfer (checks-effects-interactions).
    pub fn redeem(&mut self) {
        let who = self.env().caller();
        let cspr_out = self.ledger_balance(&Asset::Cspr, who);
        let scspr_out = self.ledger_balance(&Asset::Scspr, who);
        let csprusd_out = self.ledger_balance(&Asset::Csprusd, who);
        if cspr_out.is_zero() && scspr_out.is_zero() && csprusd_out.is_zero() {
            self.env().revert(Error::InsufficientAccountFunds);
        }
        self.cspr_of.set(&who, U256::zero());
        self.scspr_of.set(&who, U256::zero());
        self.csprusd_of.set(&who, U256::zero());

        if !cspr_out.is_zero() {
            self.payout(&Asset::Cspr, who, cspr_out);
        }
        if !scspr_out.is_zero() {
            self.payout(&Asset::Scspr, who, scspr_out);
        }
        if !csprusd_out.is_zero() {
            self.payout(&Asset::Csprusd, who, csprusd_out);
        }
        self.env().emit_event(Redeemed {
            redeemer: who,
            cspr_out,
            scspr_out,
            csprusd_out,
        });
    }

    /// Owner-only: replace the global guardrail envelope (the hard ceiling all per-account
    /// policies are clamped to).
    pub fn set_policy(&mut self, cfg: PolicyConfig) {
        self.assert_owner();
        self.write_policy(cfg);
    }

    /// Any depositor sets *their own* guardrails. The policy is validated for well-formedness here
    /// and clamped to the owner envelope at read time, so it can only ever be tighter than the
    /// owner's ceiling — never wider.
    pub fn set_my_policy(&mut self, cfg: PolicyConfig) {
        if cfg.min_scspr_bps > cfg.max_scspr_bps
            || cfg.max_scspr_bps > BPS as u32
            || cfg.max_slippage_bps > BPS as u32
        {
            self.env().revert(Error::InvalidPolicy);
        }
        let who = self.env().caller();
        self.has_policy.set(&who, true);
        self.env().emit_event(AccountPolicySet {
            account: who,
            per_action_cap_usd: cfg.per_action_cap_usd,
            daily_cap_usd: cfg.daily_cap_usd,
            max_slippage_bps: cfg.max_slippage_bps,
            min_scspr_bps: cfg.min_scspr_bps,
            max_scspr_bps: cfg.max_scspr_bps,
        });
        self.policy_of.set(&who, cfg);
    }

    /// Rotate the bounded agent key.
    pub fn set_agent(&mut self, agent: Address) {
        self.assert_owner();
        self.agent.set(agent);
    }

    /// Allow/deny a target contract for `execute_rebalance`.
    pub fn set_whitelist(&mut self, target: Address, allowed: bool) {
        self.assert_owner();
        self.whitelist.set(&target, allowed);
    }

    /// Owner kill switch — halts all agent action while `true`.
    pub fn pause(&mut self, paused: bool) {
        self.assert_owner();
        self.paused.set(paused);
        self.env().emit_event(PausedSet { paused });
    }

    // ------------------------------------------------------------------ views

    /// Aggregate base-unit balances actually held by the vault (the column sums of every account's
    /// ledger — the sum invariant asserts this equals the per-account totals).
    pub fn balances(&self) -> VaultBalances {
        VaultBalances {
            cspr: self.env().self_balance(),
            scspr: self.token_balance(self.scspr_addr()),
            csprusd: self.token_balance(self.wusdt_addr()),
        }
    }

    /// One account's ledger slice (its own base-unit holdings of each bucket).
    pub fn account_balances(&self, account: Address) -> VaultBalances {
        VaultBalances {
            cspr: self.ledger_balance(&Asset::Cspr, account).to_u512(),
            scspr: self.ledger_balance(&Asset::Scspr, account),
            csprusd: self.ledger_balance(&Asset::Csprusd, account),
        }
    }

    /// Micro-USD value of `account`'s ledger slice at the live Styks TWAP.
    pub fn account_value_usd(&self, account: Address) -> U256 {
        let twap = self.read_twap();
        let (s, u, c) = self.bucket_usd(
            self.ledger_balance(&Asset::Scspr, account),
            self.ledger_balance(&Asset::Csprusd, account),
            self.ledger_balance(&Asset::Cspr, account),
            twap,
        );
        s + u + c
    }

    /// Total USD value (micro-USD) of everything the vault holds — TVL across all accounts.
    pub fn nav_usd(&self) -> U256 {
        let twap = self.read_twap();
        let (s, u, c) = self.bucket_usd(
            self.token_balance(self.scspr_addr()),
            self.token_balance(self.wusdt_addr()),
            self.env().self_balance().to_u256().unwrap_or_default(),
            twap,
        );
        s + u + c
    }

    /// The global guardrail envelope (owner-set ceiling).
    pub fn policy(&self) -> PolicyConfig {
        self.envelope_policy()
    }

    /// The *effective* policy for `account`: its own policy clamped to the envelope, or the
    /// envelope itself if the account has not set one.
    pub fn account_policy(&self, account: Address) -> PolicyConfig {
        self.effective_policy(account)
    }

    /// USD notional `account` may still spend today under its effective daily cap.
    pub fn day_remaining_usd(&self, account: Address) -> U256 {
        let cap = self.effective_policy(account).daily_cap_usd;
        if self.current_epoch() != self.day_epoch_of.get(&account).unwrap_or_default() {
            return cap;
        }
        let spent = self.day_spent_of.get(&account).unwrap_or_default();
        cap.saturating_sub(spent)
    }

    pub fn is_paused(&self) -> bool {
        self.paused.get_or_default()
    }

    pub fn nonce(&self) -> u64 {
        self.action_nonce.get_or_default()
    }

    pub fn is_whitelisted(&self, target: Address) -> bool {
        self.whitelist.get(&target).unwrap_or(false)
    }

    // ------------------------------------------------------------------ the bounded action

    /// The single autonomous action per cycle for one `account` (spec §4.1.3). Every hard
    /// invariant is enforced here, in order, against *that account's* effective policy, before and
    /// after the cross-contract leg. Returns the [`ActionResult`] and writes a tamper-evident
    /// [`Receipt`] to the AuditLog in the same transaction.
    pub fn execute_rebalance(&mut self, account: Address, params: RebalanceParams) -> ActionResult {
        // 1. role gate + kill switch + whitelist
        self.assert_agent();
        if self.paused.get_or_default() {
            self.env().revert(Error::Paused);
        }
        if !self.whitelist.get(&params.target).unwrap_or(false) {
            self.env().revert(Error::TargetNotWhitelisted);
        }

        // 2. resolve the account's effective (clamped) policy + roll its daily-cap epoch
        let pol = self.effective_policy(account);
        self.roll_day_epoch(account);

        // 3. on-chain USD valuation via Styks (caps are USD-denominated, so a hallucinated
        //    base-unit amount is still bounded by notional)
        let twap = self.read_twap();
        let notional = self.to_usd_micros(&params.asset, params.amount, twap);

        // 4. per-action + daily caps (the account's)
        if notional > pol.per_action_cap_usd {
            self.env().revert(Error::PerActionCapExceeded);
        }
        let spent = self.day_spent_of.get(&account).unwrap_or_default();
        if spent + notional > pol.daily_cap_usd {
            self.env().revert(Error::DailyCapExceeded);
        }

        // 5. snapshot the account's allocation, dispatch (mutating only its ledger via measured
        //    deltas), snapshot again.
        let pre_alloc = self.compute_alloc(account, twap);
        let (amount_out, result) = self.dispatch(account, &params, pol.max_slippage_bps as u64);
        let post_alloc = self.compute_alloc(account, twap);

        // 6. allocation bounds (post-action) against the account's band, unless this was a NoOp
        if !matches!(params.kind, ActionKind::NoOp)
            && (post_alloc.scspr < pol.min_scspr_bps || post_alloc.scspr > pol.max_scspr_bps)
        {
            self.env().revert(Error::AllocationOutOfBounds);
        }

        // 7. commit accounting (the account's daily bucket + the global nonce)
        self.day_spent_of.set(&account, spent + notional);
        let nonce = self.action_nonce.get_or_default();
        self.action_nonce.set(nonce + 1);

        self.env().emit_event(RebalanceExecuted {
            nonce,
            account,
            action_kind: params.kind.clone(),
            amount: params.amount,
            amount_out,
            notional_usd: notional,
            target: params.target,
            result: result.clone(),
        });

        // 8. write proof cross-contract (atomic with the action)
        let receipt = Receipt {
            action_id: nonce,
            timestamp: self.env().get_block_time(),
            agent: self.env().caller(),
            account,
            action_kind: params.kind.clone(),
            regime: params.regime.clone(),
            perception_hash: params.perception_hash,
            decision_hash: params.decision_hash,
            pre_alloc_bps: pre_alloc,
            post_alloc_bps: post_alloc,
            amount: params.amount,
            notional_usd: notional,
            target: params.target,
            deploy_hash: [0u8; 32],
            result: result.clone(),
            cspr_usd_twap: U256::from(twap),
        };
        AuditLogContractRef::new(self.env(), self.audit_log_addr()).record(receipt);

        result
    }

    // ------------------------------------------------------------------ internals

    /// Dispatch the concrete on-chain leg for `account`, updating *only* that account's ledger.
    /// The input asset is debited by the requested `amount`; the output is credited from the
    /// **measured contract balance delta** (not an assumed value), which is what keeps
    /// `sum(account balances) == contract holdings` exact regardless of exchange rate or realized
    /// swap output. Returns `(amount_out, result)`; `amount_out` is the realized swap output
    /// (0 for stake/unstake/noop). Slippage is enforced in `do_swap`.
    fn dispatch(&mut self, account: Address, params: &RebalanceParams, slip: u64) -> (U256, ActionResult) {
        match params.kind {
            ActionKind::NoOp => (U256::zero(), ActionResult::Skipped),
            ActionKind::Stake => {
                // CSPR -> sCSPR; attach CSPR from the vault purse (payable stake()).
                self.require_funds(&Asset::Cspr, account, params.amount);
                let before = self.token_balance(self.scspr_addr());
                StakingContractRef::new(self.env(), params.target)
                    .with_tokens(params.amount.to_u512())
                    .stake();
                let minted = self.token_balance(self.scspr_addr()) - before;
                self.debit(&Asset::Cspr, account, params.amount);
                self.credit(&Asset::Scspr, account, minted);
                (U256::zero(), ActionResult::Success)
            }
            ActionKind::Unstake => {
                // sCSPR -> CSPR. Real unbonding is ~16h, so the native credit is whatever the
                // contract actually receives now (measured); the rest accrues out-of-band. The
                // account's sCSPR is debited immediately either way.
                self.require_funds(&Asset::Scspr, account, params.amount);
                let before = self.env().self_balance();
                StakingContractRef::new(self.env(), params.target).unstake(params.amount);
                let got = (self.env().self_balance() - before).to_u256().unwrap_or_default();
                self.debit(&Asset::Scspr, account, params.amount);
                self.credit(&Asset::Cspr, account, got);
                (U256::zero(), ActionResult::Success)
            }
            ActionKind::SwapToStable => {
                // sCSPR -> WUSDT (de-risk).
                self.require_funds(&Asset::Scspr, account, params.amount);
                let before = self.token_balance(self.wusdt_addr());
                let out = self.do_swap(params, slip);
                let delta = self.token_balance(self.wusdt_addr()) - before;
                self.debit(&Asset::Scspr, account, params.amount);
                self.credit(&Asset::Csprusd, account, delta);
                (out, ActionResult::Success)
            }
            ActionKind::SwapToRisk => {
                // WUSDT -> sCSPR (re-risk).
                self.require_funds(&Asset::Csprusd, account, params.amount);
                let before = self.token_balance(self.scspr_addr());
                let out = self.do_swap(params, slip);
                let delta = self.token_balance(self.scspr_addr()) - before;
                self.debit(&Asset::Csprusd, account, params.amount);
                self.credit(&Asset::Scspr, account, delta);
                (out, ActionResult::Success)
            }
        }
    }

    /// Approve the router and execute an exact-in swap, enforcing the slippage ceiling twice:
    /// the effective floor is `max(off-chain min_out, on-chain quote × (1 - max_slippage))`, and
    /// the realized output is re-checked against it. `slip` is the *account's* slippage ceiling.
    fn do_swap(&mut self, params: &RebalanceParams, slip: u64) -> U256 {
        if params.path.len() < 2 {
            self.env().revert(Error::InvalidPath);
        }
        let token_in = self.input_token(&params.asset);
        let router = params.target;

        // On-chain slippage floor from the live quote, intersected with the agent's min_out.
        let quote = RouterContractRef::new(self.env(), router)
            .get_amounts_out(params.amount, params.path.clone());
        let quoted_out = *quote.last().unwrap_or(&U256::zero());
        let ceiling_min_out = quoted_out * U256::from(BPS - slip) / U256::from(BPS);
        let min_out = if params.min_out > ceiling_min_out {
            params.min_out
        } else {
            ceiling_min_out
        };

        Cep18ContractRef::new(self.env(), token_in).approve(router, params.amount);
        let deadline = self.env().get_block_time() + SWAP_DEADLINE_MS;
        let amounts = RouterContractRef::new(self.env(), router).swap_exact_tokens_for_tokens(
            params.amount,
            min_out,
            params.path.clone(),
            self.env().self_address(),
            deadline,
        );
        let amount_out = *amounts.last().unwrap_or(&U256::zero());
        if amount_out < min_out {
            self.env().revert(Error::SlippageExceeded);
        }
        amount_out
    }

    /// The CEP-18 token contract being spent for a swap (`Scspr` de-risk, `Csprusd` re-risk).
    fn input_token(&self, asset: &Asset) -> Address {
        match asset {
            Asset::Scspr => self.scspr_addr(),
            Asset::Csprusd => self.wusdt_addr(),
            Asset::Cspr => self.env().revert(Error::InvalidAction),
        }
    }

    /// Transfer `amount` of `asset` from the vault to `to`; returns the CEP-18 token address moved
    /// (`None` for native CSPR) for the emitted event.
    fn payout(&self, asset: &Asset, to: Address, amount: U256) -> Option<Address> {
        match asset {
            Asset::Cspr => {
                let amount_u512 = amount.to_u512();
                if amount_u512 > self.env().self_balance() {
                    self.env().revert(Error::InsufficientBalance);
                }
                self.env().transfer_tokens(&to, &amount_u512);
                None
            }
            Asset::Scspr => {
                Cep18ContractRef::new(self.env(), self.scspr_addr()).transfer(to, amount);
                Some(self.scspr_addr())
            }
            Asset::Csprusd => {
                Cep18ContractRef::new(self.env(), self.wusdt_addr()).transfer(to, amount);
                Some(self.wusdt_addr())
            }
        }
    }

    // --- per-account ledger access -------------------------------------------------------------

    fn ledger_balance(&self, asset: &Asset, who: Address) -> U256 {
        match asset {
            Asset::Cspr => self.cspr_of.get(&who).unwrap_or_default(),
            Asset::Scspr => self.scspr_of.get(&who).unwrap_or_default(),
            Asset::Csprusd => self.csprusd_of.get(&who).unwrap_or_default(),
        }
    }

    fn credit(&mut self, asset: &Asset, who: Address, amount: U256) {
        if amount.is_zero() {
            return;
        }
        let b = self.ledger_balance(asset, who) + amount;
        self.set_ledger(asset, who, b);
    }

    fn debit(&mut self, asset: &Asset, who: Address, amount: U256) {
        let b = self.ledger_balance(asset, who);
        if amount > b {
            self.env().revert(Error::InsufficientAccountFunds);
        }
        self.set_ledger(asset, who, b - amount);
    }

    fn set_ledger(&mut self, asset: &Asset, who: Address, value: U256) {
        match asset {
            Asset::Cspr => self.cspr_of.set(&who, value),
            Asset::Scspr => self.scspr_of.set(&who, value),
            Asset::Csprusd => self.csprusd_of.set(&who, value),
        }
    }

    fn require_funds(&self, asset: &Asset, who: Address, amount: U256) {
        if self.ledger_balance(asset, who) < amount {
            self.env().revert(Error::InsufficientAccountFunds);
        }
    }

    // --- policy (envelope + per-account clamp) --------------------------------------------------

    fn envelope_policy(&self) -> PolicyConfig {
        PolicyConfig {
            per_action_cap_usd: self.per_action_cap_usd.get_or_default(),
            daily_cap_usd: self.daily_cap_usd.get_or_default(),
            max_slippage_bps: self.max_slippage_bps.get_or_default(),
            min_scspr_bps: self.min_scspr_bps.get_or_default(),
            max_scspr_bps: self.max_scspr_bps.get_or_default(),
        }
    }

    /// An account's effective policy: its own choice clamped into the owner envelope (tighten
    /// only), or the envelope itself if it never set one.
    fn effective_policy(&self, account: Address) -> PolicyConfig {
        if !self.has_policy.get(&account).unwrap_or(false) {
            return self.envelope_policy();
        }
        let e = self.envelope_policy();
        let p = self.policy_of.get(&account).unwrap_or_else(|| e.clone());
        PolicyConfig {
            per_action_cap_usd: umin(p.per_action_cap_usd, e.per_action_cap_usd),
            daily_cap_usd: umin(p.daily_cap_usd, e.daily_cap_usd),
            max_slippage_bps: p.max_slippage_bps.min(e.max_slippage_bps),
            // Tighten the band: a user may raise the floor and lower the ceiling, never the reverse.
            min_scspr_bps: p.min_scspr_bps.max(e.min_scspr_bps),
            max_scspr_bps: p.max_scspr_bps.min(e.max_scspr_bps),
        }
    }

    // --- valuation -----------------------------------------------------------------------------

    /// Convert a base-unit `amount` of `asset` into micro-USD using the Styks TWAP and the live
    /// sCSPR exchange rate (`staked/supply`).
    fn to_usd_micros(&self, asset: &Asset, amount: U256, twap: u64) -> U256 {
        match asset {
            Asset::Cspr => self.cspr_to_usd(amount, twap),
            Asset::Scspr => {
                if amount.is_zero() {
                    return U256::zero();
                }
                let (staked, supply) = self.scspr_rate();
                if supply.is_zero() {
                    return U256::zero();
                }
                let cspr_equiv = amount * staked / supply;
                self.cspr_to_usd(cspr_equiv, twap)
            }
            Asset::Csprusd => amount,
        }
    }

    fn cspr_to_usd(&self, cspr_amount: U256, twap: u64) -> U256 {
        let scale_pow = CSPR_DECIMALS + STYKS_TWAP_DECIMALS - USD_DECIMALS;
        let divisor = U256::from(10u64).pow(U256::from(scale_pow));
        cspr_amount * U256::from(twap) / divisor
    }

    /// Micro-USD value of each bucket `(scspr, csprusd, cspr)` for the given base-unit balances at
    /// the given TWAP. Used for both per-account allocation and the aggregate NAV view, so there is
    /// a single valuation path (no drift between the two).
    fn bucket_usd(&self, scspr_bal: U256, wusdt_bal: U256, cspr_bal: U256, twap: u64) -> (U256, U256, U256) {
        let scspr_usd = self.to_usd_micros(&Asset::Scspr, scspr_bal, twap);
        let csprusd_usd = wusdt_bal; // stable, already micro-USD
        let cspr_usd = self.cspr_to_usd(cspr_bal, twap);
        (scspr_usd, csprusd_usd, cspr_usd)
    }

    /// USD-normalized allocation over `account`'s three ledger buckets, summing to 10000 bps.
    fn compute_alloc(&self, account: Address, twap: u64) -> AllocationBps {
        let (scspr_usd, csprusd_usd, cspr_usd) = self.bucket_usd(
            self.ledger_balance(&Asset::Scspr, account),
            self.ledger_balance(&Asset::Csprusd, account),
            self.ledger_balance(&Asset::Cspr, account),
            twap,
        );
        let total = scspr_usd + csprusd_usd + cspr_usd;
        if total.is_zero() {
            return AllocationBps {
                scspr: 0,
                csprusd: 0,
                cspr: 0,
            };
        }
        let scspr_bps = (scspr_usd * U256::from(BPS) / total).as_u64() as u32;
        let csprusd_bps = (csprusd_usd * U256::from(BPS) / total).as_u64() as u32;
        let cspr_bps = 10_000u32 - scspr_bps - csprusd_bps;
        AllocationBps {
            scspr: scspr_bps,
            csprusd: csprusd_bps,
            cspr: cspr_bps,
        }
    }

    fn token_balance(&self, token: Address) -> U256 {
        Cep18ContractRef::new(self.env(), token).balance_of(self.env().self_address())
    }

    /// sCSPR exchange-rate inputs: `(staked_cspr, total_supply)` from the Wise staking contract.
    fn scspr_rate(&self) -> (U256, U256) {
        let staking = self.scspr_addr();
        let staked = StakingContractRef::new(self.env(), staking)
            .staked_cspr()
            .to_u256()
            .unwrap_or_default();
        let supply = StakingContractRef::new(self.env(), staking).total_supply();
        (staked, supply)
    }

    fn read_twap(&self) -> u64 {
        StyksPriceFeedContractRef::new(self.env(), self.styks_addr())
            .get_twap_price(TWAP_ID.to_string())
            .unwrap_or_revert_with(&self.env(), Error::OracleUnavailable)
    }

    fn roll_day_epoch(&mut self, account: Address) {
        let now = self.current_epoch();
        if now != self.day_epoch_of.get(&account).unwrap_or_default() {
            self.day_epoch_of.set(&account, now);
            self.day_spent_of.set(&account, U256::zero());
        }
    }

    fn current_epoch(&self) -> u64 {
        self.env().get_block_time_secs() / SECONDS_PER_DAY
    }

    fn write_policy(&mut self, cfg: PolicyConfig) {
        self.per_action_cap_usd.set(cfg.per_action_cap_usd);
        self.daily_cap_usd.set(cfg.daily_cap_usd);
        self.max_slippage_bps.set(cfg.max_slippage_bps);
        self.min_scspr_bps.set(cfg.min_scspr_bps);
        self.max_scspr_bps.set(cfg.max_scspr_bps);
        self.env().emit_event(PolicyUpdated {
            per_action_cap_usd: cfg.per_action_cap_usd,
            daily_cap_usd: cfg.daily_cap_usd,
        });
    }

    fn assert_owner(&self) {
        if self.env().caller() != self.owner.get_or_revert_with(Error::NotInitialized) {
            self.env().revert(Error::NotOwner);
        }
    }

    fn assert_agent(&self) {
        if self.env().caller() != self.agent.get_or_revert_with(Error::NotInitialized) {
            self.env().revert(Error::NotAgent);
        }
    }

    fn audit_log_addr(&self) -> Address {
        self.audit_log.get_or_revert_with(Error::NotInitialized)
    }
    fn styks_addr(&self) -> Address {
        self.styks.get_or_revert_with(Error::NotInitialized)
    }
    fn scspr_addr(&self) -> Address {
        self.scspr.get_or_revert_with(Error::NotInitialized)
    }
    fn wusdt_addr(&self) -> Address {
        self.wusdt.get_or_revert_with(Error::NotInitialized)
    }
}

/// Min of two `U256` (no `Ord::min` in scope for the CL integer type).
fn umin(a: U256, b: U256) -> U256 {
    if a < b {
        a
    } else {
        b
    }
}
