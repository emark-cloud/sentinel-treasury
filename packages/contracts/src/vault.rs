//! SentinelVault — custody boundary + policy enforcement + the bounded autonomous action
//! (spec §4.1). This is where the hard invariants live *below the agent's reach*: a fully
//! compromised agent brain still cannot exceed the USD caps, touch a non-whitelisted target,
//! breach the slippage floor, push allocation out of bounds, or act while paused (spec §11).
//!
//! Execution is **Mode A** (D-001): `execute_rebalance` makes the swap/stake cross-contract
//! calls itself and records the proof receipt to the AuditLog atomically.

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
    /// Redeem amount exceeds the caller's share balance (or supply is empty).
    InsufficientShares = 14,
}

#[odra::module(
    errors = Error,
    events = [RebalanceExecuted, PolicyUpdated, PausedSet, Deposited, Withdrawn, Redeemed]
)]
pub struct SentinelVault {
    // identity / control
    owner: Var<Address>,
    agent: Var<Address>,
    paused: Var<bool>,

    // policy / guardrails (owner-settable)
    per_action_cap_usd: Var<U256>,
    daily_cap_usd: Var<U256>,
    day_spent_usd: Var<U256>,
    day_epoch: Var<u64>,
    max_slippage_bps: Var<u32>,
    min_scspr_bps: Var<u32>,
    max_scspr_bps: Var<u32>,
    whitelist: Mapping<Address, bool>,

    // accounting / wiring
    audit_log: Var<Address>,
    action_nonce: Var<u64>,

    // share accounting (ERC-4626-style): shares track each depositor's pro-rata claim on NAV.
    // Minting/burning happen on deposit/redeem — *not* on the agent's rebalance — so they sit
    // outside the guardrail gate in `execute_rebalance` and never touch the USD caps.
    shares_supply: Var<U256>,
    share_balances: Mapping<Address, U256>,

    // protocol + asset addresses (Mode A targets; sCSPR token == Wise staking package)
    styks: Var<Address>,
    router: Var<Address>,
    scspr: Var<Address>,
    wusdt: Var<Address>,
}

#[odra::event]
pub struct RebalanceExecuted {
    pub nonce: u64,
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
pub struct PausedSet {
    pub paused: bool,
}

#[odra::event]
pub struct Deposited {
    /// Account that funded the vault and received the minted shares.
    pub depositor: Address,
    /// `None` ⇒ native CSPR; otherwise the CEP-18 token deposited.
    pub token: Option<Address>,
    /// Base-unit amount deposited.
    pub amount: U256,
    /// Shares minted to the depositor for this deposit (the off-chain position index sums these).
    pub shares_minted: U256,
}

#[odra::event]
pub struct Withdrawn {
    pub token: Option<Address>,
    pub amount: U256,
    pub to: Address,
}

#[odra::event]
pub struct Redeemed {
    /// Account that burned shares and received the in-kind payout.
    pub redeemer: Address,
    pub shares_burned: U256,
    /// Pro-rata payout legs (native CSPR + the two managed tokens).
    pub cspr_out: U256,
    pub scspr_out: U256,
    pub csprusd_out: U256,
}

#[odra::module]
impl SentinelVault {
    // ------------------------------------------------------------------ owner surface

    /// Wire identities, the AuditLog, the policy, and the protocol/asset addresses. The router
    /// and staking package are pre-whitelisted as the only legal action targets; the owner can
    /// adjust the whitelist later.
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
        self.shares_supply.set(U256::zero());
        self.day_spent_usd.set(U256::zero());
        self.day_epoch.set(self.current_epoch());
        self.write_policy(cfg);

        self.styks.set(styks);
        self.router.set(router);
        self.scspr.set(scspr);
        self.wusdt.set(wusdt);
        // Pre-whitelist the two legal targets (router for swaps, staking for stake/unstake).
        self.whitelist.set(&router, true);
        self.whitelist.set(&scspr, true);
    }

    /// Receive native CSPR into the vault purse and mint shares pro-rata to current NAV. The
    /// purse is already credited when this runs, so NAV is read *after* and the deposit value
    /// is backed out to price the mint against the pre-deposit pool (spec §4 / depositor flow).
    #[odra(payable)]
    pub fn deposit_cspr(&mut self) {
        let depositor = self.env().caller();
        let amount = self.env().attached_value().to_u256().unwrap_or_default();
        let twap = self.read_twap();
        let deposit_usd = self.cspr_to_usd(amount, twap);
        let total_before = self.total_nav_usd(twap).saturating_sub(deposit_usd);
        let minted = self.shares_to_mint(deposit_usd, total_before);
        self.mint_shares(depositor, minted);
        self.env().emit_event(Deposited {
            depositor,
            token: None,
            amount,
            shares_minted: minted,
        });
    }

    /// Pull `amount` of a managed CEP-18 token into the vault (depositor must have approved the
    /// vault) and mint shares pro-rata to NAV. Only the two managed assets (sCSPR, stable) are
    /// accepted — anything else has no defined NAV contribution and reverts.
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
        // The vault was approved by the depositor; move the tokens in (purse credited before NAV).
        Cep18ContractRef::new(self.env(), token).transfer_from(depositor, me, amount);
        let twap = self.read_twap();
        let deposit_usd = self.to_usd_micros(&asset, amount, twap);
        let total_before = self.total_nav_usd(twap).saturating_sub(deposit_usd);
        let minted = self.shares_to_mint(deposit_usd, total_before);
        self.mint_shares(depositor, minted);
        self.env().emit_event(Deposited {
            depositor,
            token: Some(token),
            amount,
            shares_minted: minted,
        });
    }

    /// User-initiated, in-kind pro-rata redemption: burn `shares_amount` and pay out the caller's
    /// proportional slice of *each* of the three buckets. This deliberately does **no** swap and
    /// **no** unstake at the contract level — the redeemer receives sCSPR tokens directly and may
    /// hold them, unstake (≈16h unbonding), or sell on the DEX (instant, slippage). That keeps the
    /// "speed → DEX, finality → unstake" choice with the user and avoids slippage/oracle risk on
    /// the exit path. Shares are burned before any transfer (checks-effects-interactions).
    pub fn redeem(&mut self, shares_amount: U256) {
        let redeemer = self.env().caller();
        let supply = self.shares_supply.get_or_default();
        if supply.is_zero() || shares_amount.is_zero() {
            self.env().revert(Error::InvalidAction);
        }
        let bal = self.share_balances.get(&redeemer).unwrap_or_default();
        if shares_amount > bal {
            self.env().revert(Error::InsufficientShares);
        }

        // Pro-rata slices against the *current* supply, before the burn.
        let cspr_out = self.env().self_balance() * shares_amount.to_u512() / supply.to_u512();
        let scspr_out = self.token_balance(self.scspr_addr()) * shares_amount / supply;
        let wusdt_out = self.token_balance(self.wusdt_addr()) * shares_amount / supply;

        self.burn_shares(redeemer, shares_amount);

        if !cspr_out.is_zero() {
            self.env().transfer_tokens(&redeemer, &cspr_out);
        }
        if !scspr_out.is_zero() {
            Cep18ContractRef::new(self.env(), self.scspr_addr()).transfer(redeemer, scspr_out);
        }
        if !wusdt_out.is_zero() {
            Cep18ContractRef::new(self.env(), self.wusdt_addr()).transfer(redeemer, wusdt_out);
        }

        self.env().emit_event(Redeemed {
            redeemer,
            shares_burned: shares_amount,
            cspr_out: cspr_out.to_u256().unwrap_or_default(),
            scspr_out,
            csprusd_out: wusdt_out,
        });
    }

    /// Owner-only withdrawal. `token: None` ⇒ native CSPR; otherwise the named CEP-18 token.
    pub fn withdraw(&mut self, token: Option<Address>, amount: U256, to: Address) {
        self.assert_owner();
        match token {
            None => {
                let bal = self.env().self_balance();
                let amount_u512 = amount.to_u512();
                if amount_u512 > bal {
                    self.env().revert(Error::InsufficientBalance);
                }
                self.env().transfer_tokens(&to, &amount_u512);
            }
            Some(t) => {
                Cep18ContractRef::new(self.env(), t).transfer(to, amount);
            }
        }
        self.env().emit_event(Withdrawn { token, amount, to });
    }

    /// Replace the guardrail policy (caps, slippage ceiling, allocation band).
    pub fn set_policy(&mut self, cfg: PolicyConfig) {
        self.assert_owner();
        self.write_policy(cfg);
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

    /// Current base-unit balances held by the vault.
    pub fn balances(&self) -> VaultBalances {
        VaultBalances {
            cspr: self.env().self_balance(),
            scspr: self.token_balance(self.scspr_addr()),
            csprusd: self.token_balance(self.wusdt_addr()),
        }
    }

    /// Total shares outstanding (the redemption denominator).
    pub fn total_shares(&self) -> U256 {
        self.shares_supply.get_or_default()
    }

    /// Shares held by `account` — its pro-rata claim on the vault's NAV.
    pub fn shares_of(&self, account: Address) -> U256 {
        self.share_balances.get(&account).unwrap_or_default()
    }

    /// Total USD value (micro-USD) of all three buckets at the live Styks TWAP.
    pub fn nav_usd(&self) -> U256 {
        self.total_nav_usd(self.read_twap())
    }

    /// Convenience: the micro-USD value of `account`'s position at the current NAV.
    pub fn position_value_usd(&self, account: Address) -> U256 {
        let supply = self.shares_supply.get_or_default();
        if supply.is_zero() {
            return U256::zero();
        }
        let shares = self.share_balances.get(&account).unwrap_or_default();
        self.total_nav_usd(self.read_twap()) * shares / supply
    }

    /// The active guardrail policy.
    pub fn policy(&self) -> PolicyConfig {
        PolicyConfig {
            per_action_cap_usd: self.per_action_cap_usd.get_or_default(),
            daily_cap_usd: self.daily_cap_usd.get_or_default(),
            max_slippage_bps: self.max_slippage_bps.get_or_default(),
            min_scspr_bps: self.min_scspr_bps.get_or_default(),
            max_scspr_bps: self.max_scspr_bps.get_or_default(),
        }
    }

    /// USD notional still spendable today (accounts for an un-rolled epoch boundary).
    pub fn day_remaining_usd(&self) -> U256 {
        let cap = self.daily_cap_usd.get_or_default();
        if self.current_epoch() != self.day_epoch.get_or_default() {
            return cap;
        }
        let spent = self.day_spent_usd.get_or_default();
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

    /// The single autonomous action per cycle (spec §4.1.3). Every hard invariant is enforced
    /// here, in order, before and after the cross-contract leg. Returns the [`ActionResult`] and
    /// writes a tamper-evident [`Receipt`] to the AuditLog in the same transaction.
    pub fn execute_rebalance(&mut self, params: RebalanceParams) -> ActionResult {
        // 1. role gate + kill switch + whitelist
        self.assert_agent();
        if self.paused.get_or_default() {
            self.env().revert(Error::Paused);
        }
        if !self.whitelist.get(&params.target).unwrap_or(false) {
            self.env().revert(Error::TargetNotWhitelisted);
        }

        // 2. roll the daily-cap epoch at the UTC boundary
        self.roll_day_epoch();

        // 3. on-chain USD valuation via Styks (caps are USD-denominated, so a hallucinated
        //    base-unit amount is still bounded by notional)
        let twap = self.read_twap();
        let notional = self.to_usd_micros(&params.asset, params.amount, twap);

        // 4. per-action + daily caps
        if notional > self.per_action_cap_usd.get_or_default() {
            self.env().revert(Error::PerActionCapExceeded);
        }
        let spent = self.day_spent_usd.get_or_default();
        if spent + notional > self.daily_cap_usd.get_or_default() {
            self.env().revert(Error::DailyCapExceeded);
        }

        // 5. snapshot allocation, dispatch the action, snapshot again. The exchange rate is read
        //    fresh inside `compute_alloc` so the *post*-action sCSPR holding is valued correctly.
        let pre_alloc = self.compute_alloc(twap);
        let (amount_out, result) = self.dispatch(&params, twap);
        let post_alloc = self.compute_alloc(twap);

        // 6. allocation bounds (post-action), unless this cycle was a NoOp
        if !matches!(params.kind, ActionKind::NoOp) {
            let lo = self.min_scspr_bps.get_or_default();
            let hi = self.max_scspr_bps.get_or_default();
            if post_alloc.scspr < lo || post_alloc.scspr > hi {
                self.env().revert(Error::AllocationOutOfBounds);
            }
        }

        // 7. commit accounting
        self.day_spent_usd.set(spent + notional);
        let nonce = self.action_nonce.get_or_default();
        self.action_nonce.set(nonce + 1);

        self.env().emit_event(RebalanceExecuted {
            nonce,
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

    /// Dispatch the concrete on-chain leg. Returns `(amount_out, result)`; `amount_out` is the
    /// realized swap output (0 for stake/unstake/noop). Slippage is enforced here.
    fn dispatch(&mut self, params: &RebalanceParams, _twap: u64) -> (U256, ActionResult) {
        match params.kind {
            ActionKind::NoOp => (U256::zero(), ActionResult::Skipped),
            ActionKind::Stake => {
                // CSPR -> sCSPR; attach CSPR from the vault purse (payable stake()).
                let amount_u512 = params.amount.to_u512();
                StakingContractRef::new(self.env(), params.target)
                    .with_tokens(amount_u512)
                    .stake();
                (U256::zero(), ActionResult::Success)
            }
            ActionKind::Unstake => {
                StakingContractRef::new(self.env(), params.target).unstake(params.amount);
                (U256::zero(), ActionResult::Success)
            }
            ActionKind::SwapToStable | ActionKind::SwapToRisk => {
                (self.do_swap(params), ActionResult::Success)
            }
        }
    }

    /// Approve the router and execute an exact-in swap, enforcing the slippage ceiling twice:
    /// the effective floor is `max(off-chain min_out, on-chain quote × (1 - max_slippage))`, and
    /// the realized output is re-checked against it.
    fn do_swap(&mut self, params: &RebalanceParams) -> U256 {
        if params.path.len() < 2 {
            self.env().revert(Error::InvalidPath);
        }
        let token_in = self.input_token(&params.asset);
        let router = params.target;

        // On-chain slippage floor from the live quote, intersected with the agent's min_out.
        let quote = RouterContractRef::new(self.env(), router)
            .get_amounts_out(params.amount, params.path.clone());
        let quoted_out = *quote.last().unwrap_or(&U256::zero());
        let slip = self.max_slippage_bps.get_or_default() as u64;
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

    /// Convert a base-unit `amount` of `asset` into micro-USD using the Styks TWAP and the live
    /// sCSPR exchange rate (`staked/supply`). The working CSPR buffer is valued the same way for
    /// completeness, though it is excluded from action notional in practice.
    fn to_usd_micros(&self, asset: &Asset, amount: U256, twap: u64) -> U256 {
        match asset {
            // micro-USD = amount(9) * twap(TWAP_DEC) / 10^(9 + TWAP_DEC - 6)
            Asset::Cspr => self.cspr_to_usd(amount, twap),
            Asset::Scspr => {
                if amount.is_zero() {
                    return U256::zero();
                }
                // sCSPR -> CSPR-equivalent at the live rate, then value as CSPR.
                let (staked, supply) = self.scspr_rate();
                if supply.is_zero() {
                    return U256::zero();
                }
                let cspr_equiv = amount * staked / supply;
                self.cspr_to_usd(cspr_equiv, twap)
            }
            // Stable refuge: 6-decimal token ≈ 1 USD, already micro-USD.
            Asset::Csprusd => amount,
        }
    }

    fn cspr_to_usd(&self, cspr_amount: U256, twap: u64) -> U256 {
        let scale_pow = CSPR_DECIMALS + STYKS_TWAP_DECIMALS - USD_DECIMALS;
        let divisor = U256::from(10u64).pow(U256::from(scale_pow));
        cspr_amount * U256::from(twap) / divisor
    }

    /// Micro-USD value of each bucket `(scspr, csprusd, cspr)` at the given TWAP. Single source
    /// of truth for both the allocation view and NAV/share accounting (no valuation drift).
    fn bucket_usd(&self, twap: u64) -> (U256, U256, U256) {
        let scspr_bal = self.token_balance(self.scspr_addr());
        let wusdt_bal = self.token_balance(self.wusdt_addr());
        let cspr_bal = self.env().self_balance().to_u256().unwrap_or_default();

        let scspr_usd = self.to_usd_micros(&Asset::Scspr, scspr_bal, twap);
        let csprusd_usd = wusdt_bal; // stable, already micro-USD
        let cspr_usd = self.cspr_to_usd(cspr_bal, twap);
        (scspr_usd, csprusd_usd, cspr_usd)
    }

    /// Total NAV (micro-USD) across the three buckets — the share-price denominator.
    fn total_nav_usd(&self, twap: u64) -> U256 {
        let (scspr_usd, csprusd_usd, cspr_usd) = self.bucket_usd(twap);
        scspr_usd + csprusd_usd + cspr_usd
    }

    /// Shares to mint for a `deposit_usd` contribution against a pool worth `total_before`.
    /// First deposit (empty supply or empty pool) mints 1 share per micro-USD; thereafter the
    /// mint is diluted by the live NAV so every depositor's share price is consistent.
    fn shares_to_mint(&self, deposit_usd: U256, total_before: U256) -> U256 {
        let supply = self.shares_supply.get_or_default();
        if supply.is_zero() || total_before.is_zero() {
            deposit_usd
        } else {
            deposit_usd * supply / total_before
        }
    }

    fn mint_shares(&mut self, to: Address, amount: U256) {
        if amount.is_zero() {
            return;
        }
        let b = self.share_balances.get(&to).unwrap_or_default();
        self.share_balances.set(&to, b + amount);
        self.shares_supply
            .set(self.shares_supply.get_or_default() + amount);
    }

    fn burn_shares(&mut self, from: Address, amount: U256) {
        let b = self.share_balances.get(&from).unwrap_or_default();
        if amount > b {
            self.env().revert(Error::InsufficientShares);
        }
        self.share_balances.set(&from, b - amount);
        self.shares_supply
            .set(self.shares_supply.get_or_default().saturating_sub(amount));
    }

    /// USD-normalized allocation over the three buckets, summing to 10000 bps.
    fn compute_alloc(&self, twap: u64) -> AllocationBps {
        let (scspr_usd, csprusd_usd, cspr_usd) = self.bucket_usd(twap);
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
        // Assign the remainder to the buffer to guarantee an exact 10000 sum (no rounding drift).
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

    fn roll_day_epoch(&mut self) {
        let now = self.current_epoch();
        if now != self.day_epoch.get_or_default() {
            self.day_epoch.set(now);
            self.day_spent_usd.set(U256::zero());
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
