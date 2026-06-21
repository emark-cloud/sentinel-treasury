# On-chain data-model reference (Rust / Odra)

This is the **canonical reference** for the on-chain structs/enums that `onchain.ts`
mirrors. The real definitions live in `packages/contracts` (Phase 2); this file keeps
the off-chain mirror honest until then. From spec §4.2.1 & §12.1.

> **bps width:** the spec writes `u16` for basis-point fields, but Casper's CL type system has no
> 16-bit integer (`u16` cannot cross the contract ABI), so the contracts use **`u32`**. Values
> still live in `[0, 10000]`. The TS mirror keeps `number`, so nothing changes off-chain.

```rust
enum ActionKind { Stake, Unstake, SwapToStable, SwapToRisk, NoOp }
enum Regime { Calm, Elevated, Stressed }
enum ActionResult { Success, Reverted, Skipped }

struct PolicyConfig {
    per_action_cap_usd: U256,
    daily_cap_usd: U256,
    max_slippage_bps: u32,
    min_scspr_bps: u32,
    max_scspr_bps: u32,
}

struct AllocationBps { scspr: u32, csprusd: u32, cspr: u32 } // sums to 10000
struct VaultBalances { cspr: U512, scspr: U256, csprusd: U256 }

struct Receipt {
    action_id: u64,
    timestamp: u64,
    agent: Address,
    action_kind: ActionKind,
    regime: Regime,
    perception_hash: [u8; 32],   // blake2b(MarketSnapshot canonical JSON)
    decision_hash:   [u8; 32],   // blake2b(Decision canonical JSON)
    pre_alloc_bps:  AllocationBps,
    post_alloc_bps: AllocationBps,
    amount: U256,
    notional_usd: U256,
    target: Address,
    deploy_hash: [u8; 32],
    result: ActionResult,
    cspr_usd_twap: U256,
}
```

## Mapping notes (Rust ⇄ TS)

| Rust | TS (`onchain.ts`) | Notes |
|---|---|---|
| `snake_case` fields | `camelCase` | naming convention per language |
| `U256` / `U512` / `u64` amounts | `string` (decimal) | avoids JS number precision loss; keeps hashing reproducible |
| `[u8; 32]` | `Hex32` (lowercase hex, no `0x`) | matches blake2b/deploy-hash hex |
| `Address` | `string` | account/contract package hash hex |
| enums | string-literal unions | variant names match exactly |

The two hashes (`perception_hash`, `decision_hash`) are produced **off-chain** by
`hashCanonical(...)` and stored verbatim on-chain. The contract never recomputes them;
verification (spec §9.2) is done by re-hashing the off-chain artifacts and comparing.
WUSDT stands in for csprUSD on Testnet (D-005) but the field name stays `csprusd`.
