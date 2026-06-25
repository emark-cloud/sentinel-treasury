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
 * A NAV/share snapshot of the whole vault (ERC-4626-style share-issuing vault). Mirrors the
 * vault's `nav_usd()` / `total_shares()` / `balances()` views; `navPerShareMicros` is derived
 * (`totalNavUsd / totalShares`, micro-USD per share) so the dashboard can price any position.
 * All on-chain numerics are decimal strings (micro-USD for `*Usd`, base units for balances).
 */
export interface NavSnapshot {
  totalNavUsd: string;
  totalShares: string;
  navPerShareMicros: string;
  balances: VaultBalances;
}

/**
 * A single depositor's position, derived from their share balance and the live NAV snapshot.
 * `assetBreakdown` is the depositor's pro-rata slice of each bucket (what an in-kind `redeem`
 * would pay out), and `pctOfPoolBps` is their share of the pool in basis points.
 */
export interface UserPosition {
  account: string;
  shares: string;
  valueUsd: string;
  pctOfPoolBps: number;
  assetBreakdown: VaultBalances;
}

/**
 * Rust: `Deposited` / `Redeemed` events the vault emits on share mint/burn. The off-chain
 * position index reconstructs per-account share balances by summing `sharesMinted` (deposits)
 * minus `sharesBurned` (redeems) per account from the vault's event stream (CSPR.cloud).
 */
export interface DepositedEvent {
  depositor: string;
  token: string | null;
  amount: string;
  sharesMinted: string;
}

export interface RedeemedEvent {
  redeemer: string;
  sharesBurned: string;
  csprOut: string;
  scsprOut: string;
  csprusdOut: string;
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
