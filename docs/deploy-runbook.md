# Deploy runbook — Sentinel Treasury contracts (casper-test)

How to reproduce the Phase-2 deploy (D-008 order, D-010 mechanism): **AuditLog → SentinelVault →
`set_vault`**, then harden the agent account (§4.3). Already executed 2026-06-21 — hashes in `.env` /
`CLAUDE.md`. This is the procedure to redo it (e.g. fresh keys, or after a contract upgrade).

## Prerequisites

These must all be in place **before** running any deploy command. The build/optimize chain and the
Livenet env are easy to get subtly wrong — check each.

1. **Pinned toolchain** (`packages/contracts/rust-toolchain.toml` selects it automatically):
   ```bash
   rustup toolchain install nightly-2026-01-01 --target wasm32-unknown-unknown
   ```
   Later nightlies' `rust-lld` rejects the Casper host imports at wasm link time — do not use bare
   `nightly` (D-009).

2. **Odra build tool:**
   ```bash
   cargo install cargo-odra --version 0.1.7
   ```

3. **`wasm-opt` + `wasm-strip` on `PATH`** — `cargo odra build` shells out to both for the optimize
   step and fails without them. They are **not** cargo crates; install the release binaries and make
   sure the dir is exported in the shell you build/deploy from (it is not permanent across fresh
   shells unless you add it to your profile):
   ```bash
   # wasm-opt  → binaryen   (https://github.com/WebAssembly/binaryen/releases)
   # wasm-strip→ wabt       (https://github.com/WebAssembly/wabt/releases, linux-x64)
   # extract the binaries into ~/.local/bin, then for every build/deploy shell:
   export PATH="$HOME/.local/bin:$PATH"
   wasm-opt --version && wasm-strip --version    # verify before building
   ```

4. **Funded keys** at `keys/owner/secret_key.pem` (owner) and `keys/agent/secret_key.pem` (agent),
   each with enough Testnet CSPR. The deploy is paid by the **owner**: budget ~700 CSPR for the two
   installs + `set_vault`; the hardening session is paid by the **agent** (~2 CSPR). Top up at the
   faucet if low (`casper-client query-balance -n <node> --purse-identifier <public-key>`).

5. **WASM built:** from `packages/contracts/`, with the tools from (3) on `PATH`:
   ```bash
   cargo odra build      # → wasm/AuditLog.wasm, wasm/SentinelVault.wasm (distinct, optimized)
   ```

## 1. Deploy both contracts

The Livenet deploy uses the **public** Testnet node, not CSPR.cloud: the Odra event watcher issues an
unauthenticated GET, so the token-gated cspr.cloud SSE 401s, while the public node needs no auth.

From `packages/contracts/`:

```bash
set -a; . ../../.env; set +a                       # contract-hash registry (STYKS_/ROUTER_/… )
export ODRA_CASPER_LIVENET_NODE_ADDRESS="https://node.testnet.casper.network/rpc"
export ODRA_CASPER_LIVENET_EVENTS_URL="https://node.testnet.casper.network/events"
export ODRA_CASPER_LIVENET_CHAIN_NAME="casper-test"
export ODRA_CASPER_LIVENET_SECRET_KEY_PATH="$PWD/../../keys/owner/secret_key.pem"   # account 0 = owner
export ODRA_CASPER_LIVENET_KEY_1="$PWD/../../keys/agent/secret_key.pem"             # account 1 = agent
export PATH="$HOME/.local/bin:$PATH"

cargo run --bin livenet_deploy --features livenet
```

It prints `AUDITLOG_CONTRACT_HASH=` and `VAULT_CONTRACT_HASH=` and runs `set_vault`. **Record both
(raw hex, no `hash-` prefix) in `.env` and the `CLAUDE.md` registry.** Vault init uses the
conservative demo policy (per-action $50 / daily $200, sCSPR 15–70 %, slippage 1 %) — edit
`bin/livenet_deploy.rs` to change it, or call `set_policy` later.

Verify the packages exist on-chain:

```bash
SRH=$(casper-client get-state-root-hash -n "$ODRA_CASPER_LIVENET_NODE_ADDRESS" | jq -r .result.state_root_hash)
casper-client query-global-state -n "$ODRA_CASPER_LIVENET_NODE_ADDRESS" --state-root-hash "$SRH" --key "hash-<VAULT_HASH>"
```

## 2. Harden the agent account (§4.3)

One atomic session (`tools/key-hardening/`): adds the owner key (w3), then sets
`key_management=3` / `deployment=1`. Atomic ⇒ a revert leaves the account untouched (no lock-out
window). The owner account hash is **embedded** in `src/main.rs` — if you redeploy with different
keys, regenerate it (`casper-client account-address --public-key <owner-pubkey>`, convert to a
`[u8; 32]` literal) and rebuild.

```bash
cd tools/key-hardening
cargo +nightly-2026-01-01 build --release --target wasm32-unknown-unknown
export PATH="$HOME/.local/bin:$PATH"
wasm-strip target/wasm32-unknown-unknown/release/key_hardening.wasm -o key_hardening.wasm

cd ../..
casper-client put-transaction session \
  --node-address "https://node.testnet.casper.network/rpc" \
  --chain-name casper-test \
  --secret-key keys/agent/secret_key.pem \
  --wasm-path tools/key-hardening/key_hardening.wasm \
  --transaction-runtime vm-casper-v1 \
  --pricing-mode classic --standard-payment true \
  --payment-amount 5000000000 --gas-price-tolerance 3
```

Verify (expect owner w3 + agent w1, `deployment:1`, `key_management:3`):

```bash
casper-client get-entity -n "https://node.testnet.casper.network/rpc" -e <AGENT_PUBLIC_KEY>
```
