# packages/contracts — Sentinel Treasury on-chain layer (Odra)

Rust + Odra 2.8.x. Two upgradable contracts (spec §4), built in **Phase 2** (`TODO.md`):

- **AuditLog** — append-only `Receipt` store (`record`/`get`/`range`/`latest`/`count`).
  No update/delete entry points — that is what makes it tamper-evident.
- **SentinelVault** — custody + policy enforcement + `execute_rebalance` (per-action /
  daily USD caps via on-chain Styks read, whitelist, slippage `min_out`, allocation
  bounds, pause). Governing spec sections: §4.1, §11, §12.1.

## Status

Phase 1 scaffold only: `Cargo.toml`, `Odra.toml`, build bins, and an empty `lib.rs`.
**Not yet `cargo odra build`-verified** (Odra deps not fetched in this environment). The
`src/` modules and `Odra.toml` registry are filled in during Phase 2.

## Commands (once contracts exist)

```bash
cargo odra build      # compile WASM for Testnet
cargo odra test       # unit tests (incl. one per guardrail invariant)
```

Deploy to Testnet via the Odra Casper/Livenet backend; record the resulting contract
hashes in the `CLAUDE.md` config registry (`VAULT_CONTRACT_HASH`, `AUDITLOG_CONTRACT_HASH`).

## Keep in sync

The `Receipt` struct and `ActionKind`/`Regime`/`ActionResult` enums here are the source
of truth; their off-chain mirror is `@sentinel/shared`
(`packages/shared/src/types/onchain.ts` + `onchain-reference.md`). The blake2b-256
perception/decision hashes are produced off-chain and stored verbatim on-chain.
