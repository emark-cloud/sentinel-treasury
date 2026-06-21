# TODO — Sentinel Treasury

Build sequence: **contracts-first**, **real Testnet from the start**, **ABI spike before choosing
execution mode**. See `CLAUDE.md` for conventions and `spec.md` / `design.md` / `resources.md` for detail.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 👤 = user-only (needs an account/key/faucet/credits) ·
🔒 = blocker for downstream work.

---

## Phase 0 — Prerequisites & spikes (unblocks everything)

> **Phase-0 status (2026-06-20):**
> 1. ✅ **Live swap proven on-chain** — CSPR→sCSPR acquire + sCSPR→WUSDT de-risk (route
>    `[sCSPR,WCSPR,WUSDT]`) executed with the agent key via build→sign→submit (`tools/cspr-trade-mcp/
>    swap-run.mjs`). Mode A (router) live. Hashes in `docs/abi-spike.md`.
> 2. ✅ **CSPR.trade MCP stood up** self-hosted vs Testnet (`tools/cspr-trade-mcp/`, ESM patch); swap
>    construction validated. Keys stay local; HTTP for orchestrator, stdio validated here.
>
> **Deferred to Phase 2 (decided 2026-06-20):**
> - Wise `stake()` purse handoff — NOT covered by the DEX MCP; resolve via the vault's cross-contract
>   call test (fund-loss risk if probed blindly off-chain).
> - Live `get_twap_price("CSPRUSD")` U64 scale — read contract-to-contract from the deployed vault.

- [x] 👤🔒 Create Casper Testnet accounts: **owner** + **agent** keypairs (casper-client key-gen). Funded via
      faucet — both 1,500 CSPR. Public keys in `.env`.
- [x] 👤🔒 Obtain **CSPR.cloud access token** (auth required on all endpoints). In `.env`; verified (HTTP 200).
- [x] 👤🔒 Obtain **Gemini API key** (aistudio.google.com/apikey). In `.env`; smoke-tested OK (D-004).
- [x] ~~Request **sponsored x402 credits**~~ — **NOT needed on Testnet** (resolved 2026-06-20). Pay with
      **WCSPR** (`3d80df21…`, already held; x402/EIP-3009-ready: `transfer_with_authorization` verified
      on-chain); "faucet" = `deposit`-wrap faucet CSPR. Resource server chooses the asset; hosted
      `x402-facilitator.cspr.cloud` covers settlement gas, auth'd by our CSPR.cloud token. See resources.md §6.
- [~] 🔒 **ABI spike** — hashes + entry-point ABIs confirmed via query-global-state (`docs/abi-spike.md`);
      live manual tx still pending:
  - [x] CSPR.trade **router**: Mode A **proven on-chain** — CSPR→sCSPR (`bb561dfe…`) + sCSPR→WUSDT
        (approve `1719731c…`, swap `5ffc74af…`), route `[sCSPR,WCSPR,WUSDT]`, deadline/min_out/decimals confirmed.
  - [~] Wise Lending **staking**: stake/unstake ABI confirmed; exchange-rate = `staked_cspr()/total_supply()` (no getter); manual stake + `stake()` purse semantics pending (not covered by DEX MCP).
  - [x] **stable** CEP-18: csprUSD N/A on Testnet → **WUSDT** confirmed (transfer/transfer_from/approve). See D-005.
  - [x] **Styks** `get_twap_price("CSPRUSD") -> Option<U64>` confirmed `Public`/readable → on-chain read (D-002); confirm U64 scale in live read.
- [x] 🔒 **Decide & record:** **Mode A** for router + staking (staking purse caveat), **on-chain Styks read**.
      Recorded in `docs/decisions.md` (D-001/D-002) + `CLAUDE.md` registry.
- [x] Stand up **CSPR.trade MCP** self-hosted against Testnet (keys stay local); swap-construction path
      validated (`tools/cspr-trade-mcp/`, `docs/cspr-trade-mcp.md`). Needs ESM-interop patch (postinstall).
- [x] Check Testnet **liquidity**: thin everywhere; **rely on Router multi-hop routing + MCP sizing**, no pool seeding (D-003).

---

## Phase 1 — Monorepo scaffold ✅ (2026-06-21)

- [x] Initialize **pnpm workspace**: `pnpm-workspace.yaml`, root `package.json`, root `tsconfig`
      (`tsconfig.base.json` + project refs) + lint/format (ESLint 9 flat config, Prettier).
- [x] Create packages: `packages/shared`, `packages/orchestrator`, `apps/dashboard` (Phase-6 placeholder);
      Rust crate `packages/contracts` (Odra skeleton — modules filled in Phase 2, not yet `cargo odra build`-verified).
- [x] 🔒 **`packages/shared`** — the proof contract (builds + 18 tests green):
  - [x] TS interfaces: `MarketSnapshot` (§5.3) in `src/types/market.ts`; `RiskVerdict` / `AllocationProposal` /
        `RebalanceAction` / `Decision` / `DeliberationTurn` (§6.3) in `src/types/decision.ts`.
  - [x] Rust-mirroring enums/structs reference: `ActionKind`, `Regime`, `ActionResult`, `AllocationBps`, `Receipt`,
        `PolicyConfig`, `VaultBalances` in `src/types/onchain.ts` + canonical Rust listing in `onchain-reference.md`.
  - [x] JSON schemas for every agent I/O (`src/schemas/index.ts`) + Ajv `validate()` helper for parse-validate-retry.
  - [x] **Canonical-JSON + blake2b-256 hashing util** (`canonicalize` + `blakejs`) in `src/hash/canonical.ts`,
        with reproducibility tests (order-independence + BLAKE2b-256 `"abc"` known vector) in `test/hash.test.ts`.

> **Phase-1 notes:** `pnpm build` / `pnpm typecheck` / `pnpm test` all pass. TS is ESM + NodeNext; `ajv`
> and `canonicalize` ship CJS with ESM-style `.d.ts`, so their default imports are cast to match Node's
> runtime interop (see comments in `canonical.ts` / `schemas/index.ts`). Prettier governs code only —
> the spec/docs markdown and `tools/` are in `.prettierignore`.

---

## Phase 2 — Contracts (the foundation) · Rust + Odra 2.8.x, upgradable

> **Phase-2 status (2026-06-21):** contracts written + **13 MockVM tests green** + **WASM build
> verified** (`cargo odra build` exits 0 → distinct `wasm/AuditLog.wasm` ~273 KB / `SentinelVault.wasm`
> ~341 KB). Odra 2.8 needs nightly (`box_patterns`); now pinned to **`nightly-2026-01-01`** in
> `rust-toolchain.toml` (later nightlies' rust-lld rejects Casper host imports). Build toolchain fixes
> (D-009): `no_std` lib scaffold, 2.8 build bins, **added missing `build.rs`** (without it both contracts
> built byte-identical wasm), `wasm-opt`/`wasm-strip` on PATH. Decisions D-006 (`u16`→`u32` bps ABI),
> D-007 (on-chain receipt `deploy_hash = 0`), D-008 (AuditLog `admin`+`set_vault` init-cycle), D-009
> (build toolchain) in `docs/decisions.md`. **Phase 2 COMPLETE (2026-06-21):** both contracts deployed to
> casper-test + agent account hardened (§4.3) + all verified on-chain — see D-010 and the checked items below.

- [x] **AuditLog** contract (`src/audit_log.rs`) — build + unit-tested first:
  - [x] `Receipt` storage (§4.2.1); append-only; entry points `record` / `get` / `range` / `latest` / `count`.
  - [x] Caller gate: only vault/agent may `record`. No update/delete entry points (tamper-evident).
        (`admin`+`set_vault` added to break the circular vault↔log wiring — D-008.)
- [x] **SentinelVault** (`src/vault.rs`) — storage + owner surface:
  - [x] Storage (§4.1.1): owner/agent/paused, policy caps, `day_spent_usd`/`day_epoch`, whitelist, alloc bounds, audit_log, nonce (+ styks/router/scspr/wusdt addresses).
  - [x] Owner entry points: `init`, `deposit_cspr`, `deposit_token`, `withdraw`, `set_policy`, `set_agent`, `set_whitelist`, `pause`.
  - [x] Views: `balances`, `policy`, `day_remaining_usd` (+ `is_paused`/`nonce`/`is_whitelisted`).
- [x] 🔒 **`execute_rebalance`** enforcement flow (§4.1.3 — the heart of bounded autonomy):
  - [x] role gate (caller == agent), `!paused`, whitelist check, day-epoch roll.
  - [x] `notional_usd` via on-chain Styks read; per-action cap + daily cap checks (USD micros).
  - [x] allocation-bounds check (`min/max_scspr_bps`, post-action); slippage `min_out` (quote-floor ∩ agent min_out, re-checked); nonce++; emit `RebalanceExecuted`.
  - [x] write `Receipt` to AuditLog (cross-contract, for atomicity; `deploy_hash=0` on-chain, reconciled off-chain — D-007).
- [x] Wire swap/stake per **Phase-0 mode decision** — **Mode A** cross-contract calls (`src/external.rs`: Router/Staking/Cep18/Styks refs).
- [x] **Guardrail unit tests** (`src/tests.rs`, one per invariant): cap breach reverts, non-whitelisted target reverts,
      slippage revert (`amount_out < min_out`), out-of-bounds allocation reverts, paused blocks action, role gate. (Mocks in `src/mocks.rs`.)
- [x] 👤🔒 **Deploy** both contracts to Testnet (Odra Livenet env, `bin/livenet_deploy.rs`, public node
      `node.testnet.casper.network`). AuditLog `3f0d61e2…982db` (tx `034015f3…`), Vault `b44ac9cc…068f95`
      (tx `010e3168…`), `set_vault` tx `c3407329…`. Both packages verified on-chain (1 version each);
      hashes recorded in `.env` + `CLAUDE.md`. Vault init'd with conservative demo policy.
- [x] 👤 **Associated-keys hardening** (§4.3): hardened the **agent account** via one-shot session code
      (`tools/key-hardening/`, tx `877ed73f…`). Verified on-chain: owner key weight 3, agent key weight 1,
      `deployment_threshold = 1`, `key_management_threshold = 3` → agent transacts but cannot rekey/escalate.

---

## Phase 3 — Perception & data · packages/orchestrator

- [ ] **Data Service**: Styks TWAP read; CSPR.trade MCP (`market_data`, `pre_trade_analysis`); CSPR.cloud
      balances/events. Interfaces typed against `packages/shared`.
- [ ] **Premium x402 endpoint** (we run **both ends**) returning HTTP 402 + payment requirements.
- [ ] **x402 client**: build payment payload (`casper:casper-test`, `exact`), EIP-712 sign (casper-eip-712),
      facilitator `/verify` → `/settle`, retry with `X-PAYMENT` header → premium signal.
- [ ] **x402 budget guard**: one paid pull / loop iteration, hourly CSPR cap, duplicate-request suppression,
      no-progress backstop.
- [ ] **Scout agent** → assemble `MarketSnapshot` with per-field **provenance** (VERIFIED/COMPUTED/ESTIMATED);
      blake2b-hash the snapshot → `perception_hash`; retain full JSON in the artifact store.

---

## Phase 4 — Agents & decision · packages/orchestrator

- [ ] **Risk agent** (Gemini 2.5 Flash) → `RiskVerdict` (regime, riskScore, drivers, hardLimits, rationale).
- [ ] **Treasury agent** → `AllocationProposal` (targetBps, action, expectedSlippageBps, rationale).
      Strict JSON schema + low temp + parse-validate-retry (one repair) → else fallback.
- [ ] **Deterministic rule engine** (pure functions): regime→allocation mapping + **clamp** (intersect LLM
      proposal with regime legal band ∩ Risk hardLimits). This is the outer envelope, not just a safety net.
- [ ] **Deliberation protocol** (proposer–critic, default R=2): Treasury proposes → Risk APPROVE/REJECT →
      revise → consensus, else `DeterministicFallback` flagged `consensus:false`. Capture **verbatim transcript**;
      blake2b-hash the `Decision` → `decision_hash`.
- [ ] **Decision logic** (§7): USD normalization via TWAP (incl. sCSPR exchange rate); `delta_usd` → **single
      largest corrective action**; size = `min(|delta|, per_action_cap, risk.maxActionUsd, day_remaining)`;
      MCP `pre_trade_analysis` slippage sizing (shrink or NoOp); derive `minOut`.

---

## Phase 5 — Execution & proof · packages/orchestrator

- [ ] **Execution Service**: casper-js-sdk **v5** `TransactionV1` targeting `execute_rebalance`; sign with the
      bounded **agent key** (host-local); submit to Testnet RPC; poll for finality (Zug); capture `deploy_hash`.
- [ ] **Idempotency & recovery**: `cycle_id`; persist intended action → `deploy_hash` → finality; reconcile
      in-flight deploys on restart (no double-execution).
- [ ] **Circuit breaker**: auto-pause (owner `pause(true)`) on N consecutive `Reverted` / anomalous loss.
- [ ] **Oracle-staleness guard**: reject cycle if Styks heartbeat stale or TWAP/spot divergence beyond threshold.
- [ ] **Proof**: write `Receipt` to AuditLog; implement the **§9.2 verification procedure** (fetch artifacts,
      recompute blake2b, assert equality with on-chain hashes, open `deploy_hash` on cspr.live).

---

## Phase 6 — Dashboard · apps/dashboard (Next.js, per design.md)

- [ ] Shell: **dark command-center**, three-zone body (state → reasoning → proof), persistent top bar.
- [ ] **Top bar**: loop stepper (Perceive·Decide·Act·Prove), scenario control (tagged `demo`), **Pause**, `Testnet` tag.
- [ ] **Left rail**: Allocation panel (target vs actual + drift), Guardrail panel (cap meters, whitelist,
      key weights, Pause), x402 meter.
- [ ] **Center (protagonist)**: Debate panel (streaming Scout/Risk/Treasury turns, consensus/fallback badges),
      Decision card, Action card (live `deploy_hash`, cspr.live link).
- [ ] **Right rail**: Receipt feed (append-only, newest-on-top, one-click **verify**).
- [ ] **Live data**: CSPR.cloud **Streaming (SSE)** for receipts/loop/balances; client-side **verify** via
      `blakejs` + `canonicalize`; `testnet.cspr.live` deep links; **CSPR.click** for owner Pause/unpause signing.
- [ ] **Motion discipline**: only loop stepper + debate move; `deploy_hash` + receipt badge are punctuation;
      Pause dims center column. **Semantic color** = regime/result (green calm/confirmed · amber elevated/fallback
      · coral stressed/reverted). Two-family type (grotesk + mono); mono for every machine value.

---

## Phase 7 — Demo & honesty

- [ ] **Scenario injection** into the perception layer (labelled `demo`): price-shock / liquidity-crunch to trigger a cycle.
- [ ] Choreograph the **3-second beat** (§15.1): shock → debate → consensus → live `deploy_hash` → `✔ on-chain` receipt.
- [ ] Reverse scenario (calm) → agent **stakes** back toward 60/40 → second receipt. Demo owner **Pause**/unpause.
- [ ] **README** with the honesty/status table: only the market event is injected; everything downstream is real on Testnet.

---

## Submission (resources.md §1)

- [ ] DoraHacks submission (rules, deadline). · [ ] CSPR.fans community-vote mobilization. · [ ] Demo video walkthrough.
