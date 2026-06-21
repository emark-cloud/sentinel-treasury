//! AuditLog — the append-only, tamper-evident receipt store (spec §4.2).
//!
//! There are **no update or delete entry points**, by design: that absence is what makes the
//! log tamper-evident. `record` is gated to the vault contract or the agent account; ids are
//! assigned by an internal monotonic counter so `range`/`latest` are always contiguous and
//! ordered, independent of any value carried in the incoming receipt.

use odra::prelude::*;

use crate::types::Receipt;

/// A receipt batch larger than this is rejected to bound gas on `range`/`latest` reads.
const MAX_QUERY_SPAN: u64 = 256;

#[odra::odra_error]
pub enum Error {
    /// Caller is neither the configured vault nor the agent account.
    Unauthorized = 100,
    /// Requested range is inverted or exceeds [`MAX_QUERY_SPAN`].
    BadRange = 101,
}

#[odra::module(errors = Error, events = [ReceiptRecorded])]
pub struct AuditLog {
    /// Admin (the vault owner) — may bind the vault address once it is deployed.
    admin: Var<Address>,
    /// The vault contract permitted to append (cross-contract record for atomicity).
    vault: Var<Address>,
    /// The bounded agent account, also permitted to append directly.
    agent: Var<Address>,
    /// Monotonic count of stored receipts; also the next index.
    count: Var<u64>,
    /// `index -> Receipt`, index in `[0, count)`.
    receipts: Mapping<u64, Receipt>,
}

/// Emitted on every append — the live feed the dashboard's receipt rail subscribes to.
#[odra::event]
pub struct ReceiptRecorded {
    pub index: u64,
    pub agent: Address,
}

#[odra::module]
impl AuditLog {
    /// Wire the append gate. `admin` (the vault owner) binds the vault address post-deploy via
    /// [`Self::set_vault`] — the vault and AuditLog have a circular dependency at deploy time.
    /// `agent` is the bounded agent account and may `record` directly.
    pub fn init(&mut self, admin: Address, agent: Address) {
        self.admin.set(admin);
        self.agent.set(agent);
        self.count.set(0);
    }

    /// Bind the vault contract permitted to append. Admin-only, one-time wiring.
    pub fn set_vault(&mut self, vault: Address) {
        let admin = self.admin.get_or_revert_with(Error::Unauthorized);
        if self.env().caller() != admin {
            self.env().revert(Error::Unauthorized);
        }
        self.vault.set(vault);
    }

    /// Append a receipt. Index is assigned internally (ignores any id in `r`), guaranteeing a
    /// contiguous, ordered log. Reverts unless the caller is the vault or the agent.
    pub fn record(&mut self, r: Receipt) {
        self.assert_writer();
        let index = self.count.get_or_default();
        self.receipts.set(&index, r);
        self.count.set(index + 1);
        self.env().emit_event(ReceiptRecorded {
            index,
            agent: self.env().caller(),
        });
    }

    /// Fetch a single receipt by index.
    pub fn get(&self, action_id: u64) -> Option<Receipt> {
        self.receipts.get(&action_id)
    }

    /// Receipts in `[from, to)`. Reverts if inverted or wider than [`MAX_QUERY_SPAN`].
    pub fn range(&self, from: u64, to: u64) -> Vec<Receipt> {
        if to < from || to - from > MAX_QUERY_SPAN {
            self.env().revert(Error::BadRange);
        }
        let end = to.min(self.count.get_or_default());
        let mut out = Vec::new();
        let mut i = from;
        while i < end {
            if let Some(r) = self.receipts.get(&i) {
                out.push(r);
            }
            i += 1;
        }
        out
    }

    /// The most recent `n` receipts, oldest-first within the returned slice.
    pub fn latest(&self, n: u32) -> Vec<Receipt> {
        let count = self.count.get_or_default();
        let n = (n as u64).min(count).min(MAX_QUERY_SPAN);
        let from = count - n;
        self.range(from, count)
    }

    /// Total receipts appended.
    pub fn count(&self) -> u64 {
        self.count.get_or_default()
    }

    fn assert_writer(&self) {
        let caller = self.env().caller();
        let is_vault = self.vault.get().map(|v| v == caller).unwrap_or(false);
        let is_agent = self.agent.get().map(|a| a == caller).unwrap_or(false);
        if !is_vault && !is_agent {
            self.env().revert(Error::Unauthorized);
        }
    }
}
