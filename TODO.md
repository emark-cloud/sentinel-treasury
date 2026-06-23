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
>
> **✅ Redeployed (D-013 + D-014, 2026-06-22):** the Phase-3 live read pinned the Styks TWAP scale at 5
> decimals (not 9), so `STYKS_TWAP_DECIMALS` was corrected 9 → 5 in `vault.rs` (the old value made the USD
> caps non-binding). MockVM 13/13 still green. The original deploy was **Locked** (non-upgradable), so an
> in-place upgrade was impossible — **both contracts were redeployed as upgradable** with the fix. Live,
> Unlocked hashes: vault `949a9c35…446f20`, AuditLog `95dd52c4…004712`. On-chain USD caps now correctly
> scaled; `livenet_deploy.rs` patched to `deploy_with_cfg(InstallConfig::upgradable())` for future fixes.

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

> **Phase-3 status (2026-06-21):** perception layer scaffolded in `packages/orchestrator` —
> typecheck/lint/build/format clean + **25 vitest tests green**. Deps added: `casper-js-sdk@5.0.12`,
> `@modelcontextprotocol/sdk`, `@noble/curves`+`@noble/hashes`, `dotenv`. casper-js-sdk ships UMD with
> no ESM `import` condition (same breakage `tools/cspr-trade-mcp` patches), so `src/casper/sdk.ts` loads
> it via `createRequire` rather than patching `node_modules`. All network sources sit behind injectable
> interfaces (live impl + static/scenario impl) so the loop, the §15.3 scenario harness, and tests share
> one seam. **Live-Testnet validation DONE (2026-06-22, D-012)** — probe scripts in
> `packages/orchestrator/scripts/`, code tightened to confirmed shapes, gate green:
> (1) **Styks off-chain TWAP read is READABLE** via the Odra `state`-dictionary key derivation (CSPRUSD
> store at field index 4, TWAP = avg of `List<Option<U64>>` = 307; heartbeat at index 3). ⚠️ raw U64 is
> ~5-decimal, NOT 1e6 micros — on-chain cap scaling needs reconciling (D-012). (2) **CSPR.cloud shapes**
> corrected (`{data}` envelope; `/contracts?contract_package_hash`, `ft-token-ownership`, deploys-by-
> pubkey). (3) **MCP shapes** corrected (`get_quote` needs `type`/token-unit amount; `get_pair_details`
> takes a pair package hash; impact tools return prose → curve from `get_quote.priceImpact`; use the
> self-hosted server for our token registry). (4) **EIP-712 digest byte-matches** the official
> `@casper-ecosystem/casper-eip-712` (proven vs the published vector); facilitator is **x402 v2** + Casper
> domain + **ed25519**; one open item: the v2 wire-envelope `scheme` field for live `/settle`.

- [x] **Data Service** (`src/data/`): Styks TWAP + sCSPR exchange-rate on-chain reads (`onchainReader.ts`,
      casper-js-sdk `queryLatestGlobalState`); CSPR.trade MCP (`mcpClient.ts` — `get_quote`/`get_pair_details`/
      `estimate_price_impact` → spot/depth/price-impact curve); CSPR.cloud REST balances + package→contract
      resolution (`csprCloud.ts`); `dataService.ts` fans out in parallel. All typed against `@sentinel/shared`.
- [x] **Premium x402 endpoint** (`src/x402/premiumServer.ts`, we run **both ends**) — `node:http`, returns
      HTTP 402 + `PaymentRequirements` (WCSPR asset, `casper:casper-test`, `exact`), 200 + signal on `X-PAYMENT`.
      Signal value is scenario-injectable (`signalProvider`).
- [x] **x402 client** (`src/x402/client.ts` + `eip712.ts` + `types.ts`): 402 → build EIP-3009
      `TransferWithAuthorization` → EIP-712 sign (secp256k1 via `@noble`, pluggable `X402Signer`) →
      facilitator `/verify` → `/settle` → retry with `X-PAYMENT` header → premium signal.
- [x] **x402 budget guard** (`src/x402/budgetGuard.ts`): one paid pull / iteration, rolling hourly CSPR cap,
      duplicate-request suppression (cache window), no-progress backstop. Pure + time-injected; 8 unit tests.
- [x] **Scout agent** (`src/agents/scout.ts`) → assembles `MarketSnapshot` with per-field **provenance**
      (VERIFIED/COMPUTED/ESTIMATED), validates against the shared schema, blake2b-hashes → `perception_hash`,
      retains full JSON in the artifact store (`src/store/artifactStore.ts`, content-addressed by hash for
      §9.2 verification). Honest fallback: when no Styks TWAP is readable, uses DEX spot labelled `fallback-spot`.

---

## Phase 4 — Agents & decision · packages/orchestrator

> **Phase-4 status (2026-06-22):** agents + decision layer landed in `packages/orchestrator` —
> typecheck/lint/build/format clean + **64 vitest tests green** (38 new). No new runtime deps: the
> Gemini client (`src/llm/gemini.ts`) is a thin `fetch` wrapper on the AI Studio `generateContent`
> REST endpoint (`responseMimeType` + `responseSchema` + low temp). Everything sits behind an
> injectable `LlmClient` (`src/llm/types.ts`) so the deliberation tests + §15.3 scenario harness run
> with a `ScriptedLlmClient` and no network — same seam as the Phase-3 data sources. The Risk critic
> is a **deterministic** veto (`critiqueProposal`), so the proposer–critic debate is reproducible and
> testable; Treasury is the LLM proposer. The on-chain action is always re-derived deterministically
> by the sizing module (no free-form amount reaches the chain); `minOut` from the slippage ceiling.

- [x] **Risk agent** (`src/agents/risk.ts`, Gemini 2.5 Flash) → `RiskVerdict` (regime, riskScore,
      drivers, hardLimits, rationale). Output **sanitized** into the policy/regime envelope; LLM-fail →
      `deterministicVerdict` (regime from `regimeRiskScore`).
- [x] **Treasury agent** (`src/agents/treasury.ts`) → `AllocationProposal` (targetBps, action,
      expectedSlippageBps, rationale). Strict JSON schema + temp 0 + parse-validate-retry (one repair via
      `generateValidated`) → else `fallbackProposal`.
- [x] **Deterministic rule engine** (`src/decision/ruleEngine.ts`, pure functions): `REGIME_BANDS`,
      `fallbackAllocation` (regime→allocation), `clampTargetBps` (intersect proposal with regime band ∩
      policy bounds ∩ Risk `hardLimits`), `classifyRegime`/`deterministicVerdict`, `critiqueProposal`.
      The outer envelope, not just a safety net.
- [x] **Deliberation protocol** (`src/decision/deliberate.ts` `Deliberator`, default R=2): Treasury
      proposes → Risk (deterministic) APPROVE/REJECT → revise → consensus, else `DeterministicFallback`
      flagged `consensus:false, source:'fallback'`. Verbatim `transcript`; `DecisionEngine` validates +
      blake2b-hashes the `Decision` → `decision_hash` + retains it in the artifact store.
- [x] **Decision logic** (§7): `src/decision/normalize.ts` (USD valuation via TWAP incl. sCSPR exchange
      rate, gas buffer excluded, weights bps) + `src/decision/sizing.ts` (`delta_usd` → **single largest
      corrective action**; size = `min(|delta|, per_action_cap, risk.maxActionUsd, day_remaining)`;
      price-impact-curve slippage shrink or NoOp; `minOut`; pre/post alloc bps for the receipt).

---

## Phase 5 — Execution & proof · packages/orchestrator

> **Phase-5 status (2026-06-22):** execution + proof layers landed in `packages/orchestrator` —
> typecheck/lint/build/format clean + **90 vitest tests green** (26 new). No new runtime deps.
> The riskiest piece — encoding the Odra `RebalanceParams` struct arg for casper-js-sdk — is solved
> by a byte-exact `bytesrepr` codec (`execution/clbytes.ts`) wrapped in `CLValue.newCLAny(...)`:
> Odra reads a named arg as the CLValue's raw value bytes, so the declared CLType is irrelevant and
> only the bytes must match (verified against the contract crates: unit enums → `u8`, structs →
> concatenated fields, `Address` → `Key` = `Account 0x00`/`Contract 0x01` + 32 bytes, `U256` →
> length-prefixed LE, `Vec` → u32 count). The vault is called **by package hash** (upgrade-stable).
> All chain I/O sits behind a `ChainClient` seam (live `RpcChainClient` + test fakes), the same
> discipline as the Phase-3 sources. Swap **routes** are derived in the execution layer (never from
> the LLM): de-risk `[sCSPR,WCSPR,WUSDT]` per abi-spike. **D-015** records the arg-encoding approach
> and the two open live-confirmation items (the AuditLog `count`/`receipts` Odra field indices,
> defaulted 3/4 from declaration order; and a live `execute_rebalance` submission).

- [x] **Execution Service** (`src/execution/`): casper-js-sdk **v5** `ContractCallBuilder` →
      `execute_rebalance` (`transaction.ts`, by **package hash**); `RebalanceParams` arg encoded via
      `clbytes.ts`+`serialize.ts` (`CLValue.newCLAny`); host-local **agent key** signer (`signer.ts`,
      PEM, ed25519/secp256k1 by pubkey prefix); submit + poll-to-finality capturing `deployHash`
      (`executionService.ts`) behind the `ChainClient` seam (`chainClient.ts`). NoOp short-circuits
      (no tx).
- [x] **Idempotency & recovery** (`cycleStore.ts`): per-`cycleId` journal `pending → submitted →
      finalized|failed|skipped`; intended action → `deployHash` → result persisted; `reconcile()`
      settles in-flight transactions on restart (no double-execution); re-`execute()` of a known
      cycle never re-submits.
- [x] **Circuit breaker** (`circuitBreaker.ts`): pure state machine; trips on N consecutive
      `Reverted` or an anomalous single-cycle USD loss; emits `shouldPause` exactly once →
      `buildPauseTx` (owner `pause(true)`); owner `reset()`.
- [x] **Oracle-staleness guard** (`oracleGuard.ts`): pure check rejecting a cycle when the Styks
      heartbeat is stale/unreadable or TWAP/spot divergence exceeds the bps ceiling.
- [x] **Proof** (`src/proof/`): `Receipt` `bytesrepr` codec (`receiptCodec.ts`, round-trippable);
      AuditLog reader over the Odra `state` dictionary (`receiptReader.ts`); the **§9.2 verification
      procedure** (`verify.ts` — fetch artifacts, recompute blake2b, assert equality with the
      on-chain `perception_hash`/`decision_hash`, flag the D-007 zero `deploy_hash`) + cspr.live deep
      links (`csprLive.ts`). The vault writes the receipt cross-contract atomically (Phase 2), so the
      off-chain layer reads + verifies rather than writing.

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
