# TODO — Sentinel Treasury

Build sequence: **contracts-first**, **real Testnet from the start**, **ABI spike before choosing
execution mode**. See `CLAUDE.md` for conventions and `spec.md` / `design.md` / `resources.md` for detail.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 👤 = user-only (needs an account/key/faucet/credits) ·
🔒 = blocker for downstream work.

---

## Phase 0 — Prerequisites & spikes (unblocks everything)

> **Immediate next (post-ABI-spike), in order:**
> 1. **Live manual tx checks** — small sCSPR→WUSDT swap (approve + `swap_exact_tokens_for_tokens`)
>    + a `stake()` to close the Mode-A purse caveat (D-001), and read a live `get_twap_price("CSPRUSD")`
>    to fix the U64 scale (D-002). Spends real Testnet funds; use the agent key. See `docs/abi-spike.md`.
> 2. **Stand up CSPR.trade MCP** self-hosted vs Testnet (keys local) — needed for slippage sizing (D-003).

- [x] 👤🔒 Create Casper Testnet accounts: **owner** + **agent** keypairs (casper-client key-gen). Funded via
      faucet — both 1,500 CSPR. Public keys in `.env`.
- [x] 👤🔒 Obtain **CSPR.cloud access token** (auth required on all endpoints). In `.env`; verified (HTTP 200).
- [x] 👤🔒 Obtain **Gemini API key** (aistudio.google.com/apikey). In `.env`; smoke-tested OK (D-004).
- [ ] 👤 Request **sponsored x402 credits** from buildathon organizers (early — free on-chain x402 usage).
- [~] 🔒 **ABI spike** — hashes + entry-point ABIs confirmed via query-global-state (`docs/abi-spike.md`);
      live manual tx still pending:
  - [~] CSPR.trade **router**: swap+approve ABI confirmed (Mode A); manual swap pending.
  - [~] Wise Lending **staking**: stake/unstake ABI confirmed; exchange-rate = `staked_cspr()/total_supply()` (no getter); manual stake + `stake()` purse semantics pending.
  - [x] **stable** CEP-18: csprUSD N/A on Testnet → **WUSDT** confirmed (transfer/transfer_from/approve). See D-005.
  - [x] **Styks** `get_twap_price("CSPRUSD") -> Option<U64>` confirmed `Public`/readable → on-chain read (D-002); confirm U64 scale in live read.
- [x] 🔒 **Decide & record:** **Mode A** for router + staking (staking purse caveat), **on-chain Styks read**.
      Recorded in `docs/decisions.md` (D-001/D-002) + `CLAUDE.md` registry.
- [ ] Stand up **CSPR.trade MCP** self-hosted against Testnet (keys stay local); validate swap-construction path.
- [x] Check Testnet **liquidity**: thin everywhere; **rely on Router multi-hop routing + MCP sizing**, no pool seeding (D-003).

---

## Phase 1 — Monorepo scaffold

- [ ] Initialize **pnpm workspace**: `pnpm-workspace.yaml`, root `package.json`, root `tsconfig` + lint/format.
- [ ] Create packages: `packages/shared`, `packages/orchestrator`, `apps/dashboard`; Rust crate `packages/contracts`.
- [ ] 🔒 **`packages/shared`** — the proof contract:
  - [ ] TS interfaces: `MarketSnapshot` (§5.3), `RiskVerdict` / `AllocationProposal` / `RebalanceAction` / `Decision` (§6.3).
  - [ ] Rust-mirroring enums/structs reference: `ActionKind`, `Regime`, `ActionResult`, `AllocationBps`, `Receipt`.
  - [ ] JSON schemas for every agent I/O (for parse-validate-retry).
  - [ ] **Canonical-JSON + blake2b-256 hashing util** (`canonicalize` + `blakejs`) with reproducibility tests.

---

## Phase 2 — Contracts (the foundation) · Rust + Odra 2.8.x, upgradable

- [ ] **AuditLog** contract (build + unit-test first — it's the simplest):
  - [ ] `Receipt` storage (§4.2.1); append-only; entry points `record` / `get` / `range` / `latest` / `count`.
  - [ ] Caller gate: only vault/agent may `record`. No update/delete entry points (tamper-evident).
- [ ] **SentinelVault** — storage + owner surface:
  - [ ] Storage (§4.1.1): owner/agent/paused, policy caps, `day_spent_usd`/`day_epoch`, whitelist, alloc bounds, audit_log, nonce.
  - [ ] Owner entry points: `init`, `deposit_cspr`, `deposit_token`, `withdraw`, `set_policy`, `set_agent`, `set_whitelist`, `pause`.
  - [ ] Views: `balances`, `policy`, `day_remaining_usd`.
- [ ] 🔒 **`execute_rebalance`** enforcement flow (§4.1.3 — the heart of bounded autonomy):
  - [ ] role gate (caller == agent), `!paused`, whitelist check, day-epoch roll.
  - [ ] `notional_usd` via on-chain Styks read (or verified signed-price-in); per-action cap + daily cap checks.
  - [ ] allocation-bounds check (`min/max_scspr_bps`); slippage `min_out`; nonce++; emit `RebalanceExecuted`.
  - [ ] write `Receipt` to AuditLog (cross-contract, for atomicity).
- [ ] Wire swap/stake per **Phase-0 mode decision** (Mode A cross-contract calls **or** Mode B escrow-release).
- [ ] **Guardrail unit tests** (one per invariant): cap breach reverts, non-whitelisted target reverts,
      slippage revert (`amount_out < min_out`), out-of-bounds allocation reverts, paused blocks action, role gate.
- [ ] 👤🔒 **Deploy** both contracts to Testnet (Odra Casper/Livenet backend); record hashes in `CLAUDE.md` registry.
- [ ] 👤 **Associated-keys hardening** (§4.3): agent key weight 1, owner weight 3; `deployment_threshold = 1`,
      `key_management_threshold = 3`. Verify agent can transact but cannot rekey/escalate.

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
