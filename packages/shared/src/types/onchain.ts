/**
 * TypeScript mirror of the on-chain (Rust / Odra) data models — spec §4.2.1 & §12.1.
 *
 * These shapes exist so the off-chain orchestrator can construct, read, and verify
 * `Receipt`s against the AuditLog contract. The Rust definitions in
 * `packages/contracts` are the source of truth for on-chain storage; this file must
 * track them. See `src/types/onchain-reference.md` for the canonical Rust listing.
 *
 * Numeric on-chain fields (U256/U512/u64) are represented as decimal **strings** here
 * to avoid JS number precision loss and to keep canonical-JSON hashing reproducible.
 */

/** Rust: `enum ActionKind` — the single corrective step a cycle may take. */
export type ActionKind = 'Stake' | 'Unstake' | 'SwapToStable' | 'SwapToRisk' | 'NoOp';

/** Rust: `enum Regime` — market classification from the Risk agent. */
export type Regime = 'Calm' | 'Elevated' | 'Stressed';

/** Rust: `enum ActionResult` — outcome of an `execute_rebalance` call. */
export type ActionResult = 'Success' | 'Reverted' | 'Skipped';

/** 32-byte hash as lowercase hex, no `0x` prefix (blake2b-256 or deploy hash). */
export type Hex32 = string;

/** Rust: `struct AllocationBps` — sCSPR / csprUSD(WUSDT) / CSPR weights; sums to 10000. */
export interface AllocationBps {
  scspr: number;
  csprusd: number;
  cspr: number;
}

/** Rust: `struct VaultBalances` — base-unit balances, decimal strings (U512/U256). */
export interface VaultBalances {
  cspr: string;
  scspr: string;
  csprusd: string;
}

/** Rust: `struct PolicyConfig` — owner-settable guardrail policy (spec §12.1). */
export interface PolicyConfig {
  perActionCapUsd: string;
  dailyCapUsd: string;
  maxSlippageBps: number;
  minScsprBps: number;
  maxScsprBps: number;
}

/**
 * Aggregate TVL view of the whole (multi-tenant) vault — the sum of every account's ledger.
 * Mirrors the vault's `nav_usd()` / `balances()` views. There are no shares: each depositor owns
 * an explicit ledger slice, so the vault's holdings are just the column sums of all accounts.
 * All on-chain numerics are decimal strings (micro-USD for `*Usd`, base units for balances).
 */
export interface NavSnapshot {
  totalNavUsd: string;
  balances: VaultBalances;
}

/**
 * A single depositor's position in the multi-tenant vault: their *own* base-unit ledger
 * `balances` (what a withdraw/redeem pays out directly — no pro-rata pooling), the micro-USD
 * `valueUsd` of that slice, and its USD-normalized `allocBps` against their own band. Mirrors the
 * vault's `account_balances()` / `account_value_usd()` views.
 */
export interface UserPosition {
  account: string;
  balances: VaultBalances;
  valueUsd: string;
  allocBps: AllocationBps;
}

/**
 * Rust: `Deposited` / `Withdrawn` / `Redeemed` events the vault emits as funds move in/out of an
 * account's ledger. The off-chain indexer uses `Deposited` only to *discover the live account set*
 * (whose ledgers to read + which accounts the agent should iterate); authoritative balances come
 * from the per-account contract views, not event replay.
 */
export interface DepositedEvent {
  depositor: string;
  token: string | null;
  amount: string;
}

export interface WithdrawnEvent {
  account: string;
  token: string | null;
  amount: string;
}

export interface RedeemedEvent {
  redeemer: string;
  csprOut: string;
  scsprOut: string;
  csprusdOut: string;
}

/** Rust: `AccountPolicySet` — a depositor set their own (envelope-clamped) guardrails. */
export interface AccountPolicySetEvent {
  account: string;
  perActionCapUsd: string;
  dailyCapUsd: string;
  maxSlippageBps: number;
  minScsprBps: number;
  maxScsprBps: number;
}

/**
 * Rust: `struct Receipt` — the compact, tamper-evident record appended to AuditLog
 * (spec §4.2.1). `perceptionHash`/`decisionHash` anchor the full off-chain artifacts:
 * `blake2b(MarketSnapshot) == perceptionHash` and `blake2b(Decision) == decisionHash`.
 */
export interface Receipt {
  actionId: string;
  timestamp: string;
  agent: string;
  /** The depositor account whose ledger slice this action moved (multi-tenant vault). */
  account: string;
  actionKind: ActionKind;
  regime: Regime;
  perceptionHash: Hex32;
  decisionHash: Hex32;
  preAllocBps: AllocationBps;
  postAllocBps: AllocationBps;
  amount: string;
  notionalUsd: string;
  target: string;
  deployHash: Hex32;
  result: ActionResult;
  csprUsdTwap: string;
}
