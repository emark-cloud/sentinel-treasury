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

**Deployed to casper-test** (upgradable redeploy 2026-06-22, D-014): AuditLog `95dd52c4…004712`, Vault
`949a9c35…446f20` (both `lock_status: Unlocked`, verified on-chain; `set_vault` wired). These carry the
D-013 `STYKS_TWAP_DECIMALS=5` scale fix and supersede the Locked Phase-2 pair (AuditLog `3f0d61e2…982db`,
Vault `b44ac9cc…068f95`, 2026-06-21), which could not be upgraded in place. The agent account is hardened
per §4.3 (owner w3 / agent w1, `deployment=1` / `key_management=3`) — account-level, unaffected by the
redeploy. `cargo odra build` produces distinct optimized `wasm/AuditLog.wasm` (~273 KB) /
`wasm/SentinelVault.wasm` (~341 KB). See `docs/decisions.md` D-006/D-007/D-008 (ABI width / receipt
`deploy_hash` / init-cycle), **D-009** (build toolchain — pinned `nightly-2026-01-01`, `no_std` scaffold,
`build.rs`, `wasm-opt`/`wasm-strip`), **D-010** (deploy + hardening: `bin/livenet_deploy.rs`, public node,
`tools/key-hardening/`), and **D-013/D-014** (scale fix + upgradable redeploy).

### Build prerequisites

```
rustup toolchain install nightly-2026-01-01 --target wasm32-unknown-unknown   # pinned (rust-toolchain.toml)
cargo install cargo-odra --version 0.1.7
# wasm-opt (binaryen) + wasm-strip (wabt) must be on PATH for the optimize step:
export PATH="$HOME/.local/bin:$PATH"   # wherever you put the two binaries; not permanent across shells
```

Full prerequisites + the exact deploy/hardening commands: **`docs/deploy-runbook.md`**.

## Commands

```bash
cargo +nightly test   # guardrail suite on the MockVM (Odra 2.8 needs nightly — box_patterns)
cargo odra build      # compile WASM for Testnet (needs cargo-odra)
cargo odra test       # WASM-backend tests
```

Deploy order: **AuditLog → Vault → `audit_log.set_vault(vault)`** (admin-only), via
`bin/livenet_deploy.rs` (Odra Livenet env, `--features livenet`) against the public Testnet node;
then harden the agent account with `tools/key-hardening/`. **Full steps + prerequisites (toolchain,
`wasm-opt`/`wasm-strip` on `PATH`, Livenet env vars, funded keys): `docs/deploy-runbook.md`.** Record
the resulting hashes in the `CLAUDE.md` registry (`VAULT_CONTRACT_HASH`, `AUDITLOG_CONTRACT_HASH`).

## Keep in sync

The `Receipt` struct and `ActionKind`/`Regime`/`ActionResult` enums here are the source
of truth; their off-chain mirror is `@sentinel/shared`
(`packages/shared/src/types/onchain.ts` + `onchain-reference.md`). The blake2b-256
perception/decision hashes are produced off-chain and stored verbatim on-chain.
