# packages/contracts — Sentinel Treasury on-chain layer (Odra)

Rust + Odra 2.8.x. Two upgradable contracts (spec §4), built in **Phase 2** (`TODO.md`):

- **AuditLog** — append-only `Receipt` store (`record`/`get`/`range`/`latest`/`count`).
  No update/delete entry points — that is what makes it tamper-evident.
- **SentinelVault** — custody + policy enforcement + `execute_rebalance` (per-action /
  daily USD caps via on-chain Styks read, whitelist, slippage `min_out`, allocation
  bounds, pause). Governing spec sections: §4.1, §11, §12.1.

## Layout

```
src/
├── types.rs       # ActionKind/Regime/ActionResult/Asset, PolicyConfig, AllocationBps,
│                  #   VaultBalances, Receipt, RebalanceParams (odra_type / odra_error)
├── external.rs    # Mode-A cross-contract refs: Router, Staking, Cep18, StyksPriceFeed
├── audit_log.rs   # AuditLog contract (+ admin/set_vault to break the init cycle — D-008)
├── vault.rs       # SentinelVault: storage, owner surface, views, execute_rebalance
├── mocks.rs       # #[cfg(test)] MockVM stand-ins (token/staking/router/styks)
└── tests.rs       # #[cfg(test)] guardrail + happy-path suite
```

## Status (Phase 2 — 2026-06-21)

Contracts written; **13 MockVM tests green** (`cargo +nightly test`). Coverage:

- **Guardrails (one test per invariant, spec §11):** per-action cap, daily cap,
  non-whitelisted target, slippage `amount_out < min_out`, allocation out-of-bounds,
  pause, agent role-gate.
- **AuditLog:** append-only / contiguous `range`·`latest`·`count`·`get`; unauthorized `record` revert.
- **Happy paths:** stake (records a receipt; notional/twap/alloc asserted) and de-risk swap.

Not yet `cargo odra build`-verified to WASM, and not deployed — both need `cargo-odra`
installed and (deploy) funded Testnet keys. See `docs/decisions.md` D-006/D-007/D-008 for the
ABI-width, receipt `deploy_hash`, and init-cycle decisions taken here.

## Commands

```bash
cargo +nightly test   # guardrail suite on the MockVM (Odra 2.8 needs nightly — box_patterns)
cargo odra build      # compile WASM for Testnet (needs cargo-odra)
cargo odra test       # WASM-backend tests
```

Deploy order: **AuditLog → Vault → `audit_log.set_vault(vault)`** (admin-only). Deploy to
Testnet via the Odra Casper/Livenet backend; record the resulting contract hashes in the
`CLAUDE.md` config registry (`VAULT_CONTRACT_HASH`, `AUDITLOG_CONTRACT_HASH`).

## Keep in sync

The `Receipt` struct and `ActionKind`/`Regime`/`ActionResult` enums here are the source
of truth; their off-chain mirror is `@sentinel/shared`
(`packages/shared/src/types/onchain.ts` + `onchain-reference.md`). The blake2b-256
perception/decision hashes are produced off-chain and stored verbatim on-chain.
