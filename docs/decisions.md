# Decisions — Sentinel Treasury

Append-only record of locked technical decisions. Each entry: context → decision → consequence.
Phase-0 decisions feed the `CLAUDE.md` config registry. Status legend: `PENDING` (awaiting ABI
spike / data) · `DECIDED` · `REVISITED`.

---

## D-016 — Dashboard demo data seam: scenario-driven, real hashing/verify — DECIDED (2026-06-23)

- **Status:** DECIDED — 2026-06-23, Phase 6 (dashboard).
- **Context:** the Phase-6 dashboard (`apps/dashboard`, Next.js 15 / React 19) is a presentation
  surface that must render the full perceive→decide→act→prove loop with the design.md motion beat. The
  live loop *runner* (a long-running orchestrator process emitting cycles over CSPR.cloud SSE) is
  Phase-7 work; the orchestrator today ships the loop's building blocks as libraries, not a stream.
- **Decision:** drive the dashboard from a **`CycleSource` seam** (`lib/scenario.ts`) with a
  `ScenarioSource` demo implementation that synthesizes complete cycles from the **real
  `@sentinel/shared` shapes** (`MarketSnapshot` / `Decision` / `Receipt`) and the **real canonical-JSON
  blake2b hashing**. This mirrors the orchestrator's injectable-source discipline (Phase 3/4/5): a
  live SSE-backed source drops in behind the same interface in Phase 7 with no panel changes. The
  receipt-feed **verify** button recomputes genuine `blake2b(snapshot)==perception_hash` /
  `blake2b(decision)==decision_hash` in-browser (`lib/verify.ts`) — the proof half is not mocked.
- **Honesty (spec §15.3 / design.md §8):** scenario controls are visibly tagged `demo` and styled
  apart (dashed amber); a persistent `Testnet` tag sits in the top bar; deploy/settle hashes link to
  `testnet.cspr.live`. The demo-generated `deploy_hash`/`settle_tx` values are random placeholders
  until the live runner lands — they are clearly the simulated half (only the trigger is injected; on a
  live deployment everything downstream is real). Contract hashes, whitelist, key weights and policy in
  the guardrail panel are the **real** deployed values from the CLAUDE.md registry.
- **Consequence:** no chart dependency was added — the allocation donut and meters are hand-rolled SVG
  to keep the bundle lean and the aesthetic controlled (design.md named Recharts as optional). Fonts
  use robust CSS stacks (grotesk + `ui-monospace`) rather than a network font fetch, so the build is
  offline-safe. CSPR.click owner-signing for live Pause/unpause is deferred to Phase 7 alongside the
  SSE runner; the Pause control today drives the on-screen kill-switch lock.

## D-015 — Phase-5 execution arg encoding + open live items — DECIDED (2026-06-22)

- **Status:** DECIDED — 2026-06-22, Phase 5 (execution & proof).
- **Context:** `SentinelVault::execute_rebalance(params: RebalanceParams)` takes an `#[odra::odra_type]`
  struct arg. casper-js-sdk v5 has no generic struct CLValue codec, and we won't patch `node_modules`
  or hand-roll via `casper-client`.
- **Decision:** encode the struct's exact Casper `bytesrepr` in TS (`execution/clbytes.ts` +
  `serialize.ts`) and wrap it in **`CLValue.newCLAny(bytes)`**. Odra reads a named arg as the
  CLValue's raw *value* bytes and applies `FromBytes`, so the declared CLType is irrelevant — only
  the bytes must match. Wire format confirmed against the contract + odra-macros 2.8 crates: unit
  enums (`ActionKind`/`Regime`/`Asset`) → a single `u8` variant index; structs → fields concatenated
  in declaration order; `U256`/`U512` → 1 length byte + minimal LE; `u64`/`u32` → fixed LE;
  `[u8;32]` → 32 raw bytes; `Address` → `Key` bytes (`Account = 0x00 ++ 32`, `Contract` → `Key::Hash`
  `= 0x01 ++ 32`); `Vec<T>` → `u32` count + elements. The vault is called **by package hash**
  (`ContractCallBuilder.byPackageHash`) so upgrades don't move the call target.
- **Consequence:** the same codec parses `Receipt` back from the AuditLog Odra `state` dictionary
  (`proof/receiptCodec.ts` + `receiptReader.ts`) for §9.2 verification. Swap **routes** are derived
  in the execution layer from the configured token packages (never from the LLM): de-risk
  `[sCSPR,WCSPR,WUSDT]` (abi-spike proven), re-risk the reverse.
- **Open (live-confirm, mirrors D-012 for Styks):**
  1. **AuditLog Odra field indices** for `count`/`receipts` are defaulted to **3/4** from declaration
     order (`admin,vault,agent,count,receipts`); a live dictionary read should confirm them (they are
     overridable on `AuditLogReceiptReader`). The reader is best-effort (`null` on miss), so a wrong
     index degrades gracefully.
  2. **Live `execute_rebalance` submission** with the agent key (build→sign→submit→finality) is not
     yet exercised on Testnet — all Phase-5 logic is covered by unit tests behind the `ChainClient`
     seam; the live round-trip is the remaining integration step before the demo.

---

## Confirmed Testnet contract hashes (2026-06-20)

Verified via CSPR.cloud REST (`/contract-packages/{hash}`), descriptions/owner matched:

| Contract | Package hash | Source of truth |
|---|---|---|
| Styks `StyksPriceFeed` | `2879d6e927289197aab0101cc033f532fe22e4ab4686e44b5743cb1333031acc` | desc matches styks.odra.dev; site styks.odra.dev |
| CSPR.trade Router | `04a11a367e708c52557930c4e9c1301f4465100d1b1b6d0a62b48d3e32402867` | desc "CSPR.trade Router… token swaps, multi-hop routing"; featured |
| Staked CSPR (sCSPR) | `baa50d1500aa5361c497c06b40f2822ebb0b5fce5b1c3a037ea628cb68d920f3` | site testnet.wiselending.com/liquid-staking; featured |
| Wrapped CSPR (WCSPR) | `3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e` | featured; first hop in router swap paths |
| WUSDT (Wrapped Tether) — stable refuge (D-005) | `287873e640fc0dbf3b7bc828a30e1d8ea857649a401b5b5f1ba29ab8bb741100` | token0 of WUSDT pools; Testnet stand-in for csprUSD |

Still need entry-point ABIs for each (the `casper-client query-global-state` spike) — hashes only,
not yet exercised. The sCSPR package == the Wise Lending staking contract (single package); confirm
stake/unstake + exchange-rate read entry points on it.

## D-005 — Stable-refuge token on Testnet — DECIDED: use WUSDT

- **Status:** DECIDED — 2026-06-20, after team confirmation in Casper Developers Telegram.
- **Team answer:** (1) Sarson **csprUSD** is a separate Sarson Funds project — not reliably
  available to us on Testnet. (2) There **is** a direct **sCSPR/WUSDT** pair on Testnet, but its
  liquidity is very low, **which is why the CSPR.trade Router uses multi-hop routing**.
- **Decision:** the risk-off / stable-refuge asset on Testnet is **WUSDT (Wrapped Tether)**
  `287873e640fc0dbf3b7bc828a30e1d8ea857649a401b5b5f1ba29ab8bb741100`, in place of csprUSD. Label
  this honestly in the README status table (csprUSD is the intended mainnet asset; WUSDT is the
  Testnet stand-in).
- **Execution consequence:** do NOT trade the shallow direct sCSPR/WUSDT pool blindly — **route via
  the CSPR.trade Router** (it finds the best path, e.g. sCSPR→WETH→WUSDT or sCSPR→…→WCSPR→WUSDT) and
  **size to depth with MCP `pre_trade_analysis`** (shrink/NoOp on thin liquidity). See D-003.
- **Liquidity graph confirmed on-chain (WUSDT pools):** WUSDT/WCSPR `544f23c9…` (deepest WUSDT pool),
  WUSDT/WETH `bb75…`, WUSDT/CSPR.ham `939d…`, WUSDC/WUSDT `f667…`. WUSDT decimals/exact reserves
  deferred to the ABI spike / MCP (token is a Casper-2.x AddressableEntity; metadata read pending).

### (superseded) Original csprUSD investigation — kept for context
- **Context:** spec names **Sarson Funds csprUSD** (CEP-18) as the risk-off bucket. A full scan of
  CSPR.cloud approved contract-packages found **no** package named `csprUSD`/`Sarson`/`stable`.
  What exists on Testnet is a swarm of test stables: `MockUSDC` (many), `Demo USDC`, `tUSDC`,
  `tUSDT`, `x402USD`, `CaspilotDemoUSD`.
- **Open questions:** (1) Is Sarson csprUSD actually deployed on Testnet, and under what hash?
  (2) Does CSPR.trade have a **liquid** csprUSD (or any stable) pair for the de-risk swap? The
  featured CSPR.trade pairs do not include csprUSD — this couples to D-003 (liquidity).
- **Next:** ask in Casper Developers Telegram / buildathon mentors for the Sarson csprUSD Testnet
  hash; **or** decide to use an available test stable that has a real CSPR.trade pool as the
  Testnet stand-in (label it honestly in the README status table).
- **Decision:** _TBD_

### Alternative-stable viability check (2026-06-20) — feeds D-003

Mapped all 17 CSPR.trade pairs and read pool reserves on-chain. **Structural finding: there is NO
direct sCSPR↔stable or WCSPR↔stable pool on Testnet.** Only two stables have any pool at all:

| Test stable | Token package hash | Pools it appears in |
|---|---|---|
| **Wrapped Tether (USDT)** — best candidate | `287873e640fc0dbf3b7bc828a30e1d8ea857649a401b5b5f1ba29ab8bb741100` | WrTether–WETH, WrTether–CSPR.ham, WrUSDCoin–WrTether |
| Wrapped USD Coin (USDC) | _(token0 of WrUSDCoin–WrTether pair)_ | WrUSDCoin–WrTether only |

Supporting hashes: WETH Token `711f2febf66e62feb2af0d5a45bb6c7863c4e6ac077d43b2416e02722c13af05`;
pairs WETH–sCSPR contract `30891f…236f7` (pkg `59c4…98aa1`), WrTether–WETH contract `b23fd0…9df24`
(pkg `bb75…1deac`).

- **Only sCSPR→stable route:** `sCSPR → WETH → Wrapped Tether` (2-hop). Both legs are thin: the four
  sCSPR pools each hold only ~50k–100k sCSPR (paired with meme/WETH tokens, not stables), and the
  WrTether–WETH pool isn't even in WETH's top-30 holders. A real de-risk trade through this route
  would eat severe slippage.
- **Implication (D-003):** no deep stable route exists today. Practical options, in order:
  1. **Seed our own pool** — mint/control a test stable and add a **direct sCSPR↔stable** (or
     WCSPR↔stable) pool with enough depth for capped demo trades. Cleanest, most reliable for demo.
  2. Use **Wrapped Tether** via the 2-hop route and **size demo trades to the available depth**
     (let CSPR.trade MCP `pre_trade_analysis` shrink/NoOp), accepting high slippage ceilings.
  3. Keep pursuing the real Sarson csprUSD hash (D-005) in parallel; doesn't unblock liquidity.
- **Recommendation:** Option 1 (seed a direct pool) for a clean demo; Wrapped Tether
  (`287873e6…`) as the stable asset if we don't get Sarson csprUSD. Confirm exact depth/slippage via
  the CSPR.trade MCP before locking sizing.

- **Status:** DECIDED (provisional) — 2026-06-20, from ABI spike. Confirm with live manual
  swap/stake before locking (esp. the staking purse semantics).
- **Context:** `execute_rebalance` either makes atomic cross-contract calls into the protocol
  (Mode A) or caps+releases funds for an off-chain service to call the protocol (Mode B). The
  choice is made **per protocol** based on confirmed Testnet ABIs (CLAUDE.md "Locked decisions").
- **Decision (CSPR.trade router):** **Mode A (atomic).** All swap entry points are `Public` and
  callable cross-contract. De-risk = `approve(router, amount)` on the input token, then
  `swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to, deadline)` inside
  `execute_rebalance`. `amount_out_min` = the on-chain slippage floor (`min_out`). Size with
  `get_amounts_out(amount_in, path)`. **Path corrected (live MCP `get_quote`, 2026-06-20):** the
  router's best sCSPR→WUSDT route is **`[sCSPR, WCSPR, WUSDT]`** (via the deep WUSDT/WCSPR pool),
  not the WETH-bridged guess. Decimals sCSPR=9 / WUSDT=6; entry point + `deadline`/`min_out`
  encoding confirmed in a built (unsigned) TransactionV1. See `docs/cspr-trade-mcp.md`.
- **Router leg — VALIDATED ON-CHAIN** (2026-06-20) via the self-hosted MCP + agent key:
  CSPR→sCSPR acquire (`bb561dfe…`) and sCSPR→WUSDT de-risk (approve `1719731c…` + swap `5ffc74af…`),
  all executed OK on Testnet. Mode A (router) is live-proven; `swap_run.mjs` drives build→sign→submit.
- **Decision (Wise Lending staking):** **Mode A (atomic), with a caveat to verify.** `stake()`,
  `unstake(scspr_amount:U256)`, `claim()` are all `Public`. **Open item:** `stake()` takes no amount
  arg and is payable — CSPR is supplied via a purse / the contract's loose-token pool
  (`__contract_main_purse`, `add_loose_tokens`/`restake_loose_tokens`). Must confirm the
  purse-handoff pattern from Odra before committing; if cross-contract purse passing is awkward,
  fall back to **Mode B** for the stake (grow) leg only. The de-risk (swap) leg stays Mode A.
  **Status of this caveat (2026-06-20):** still OPEN — the CSPR.trade MCP is DEX-only and does not
  cover Wise Lending staking, so it doesn't resolve the purse handoff. Need Wise integration detail
  (or a careful session-WASM test) before any live `stake()`; risk of stuck funds otherwise. Note:
  sCSPR for swap testing can be acquired via the direct **CSPR→sCSPR** DEX pool instead of staking.
- **No exchange-rate getter:** the sCSPR→CSPR rate must be **COMPUTED** = `staked_cspr()` (U512) /
  `total_supply()` (U256). Label it COMPUTED in Scout provenance. Used for USD normalization (§7).
- **Consequence:** recorded in each `Receipt`; drives Phase-2 `execute_rebalance` wiring.

## D-002 — USD conversion: on-chain Styks read vs signed-price-in

- **Status:** DECIDED — 2026-06-20, from ABI spike. On-chain Styks read.
- **Context:** `notional_usd` cap enforcement needs a USD price on-chain.
- **Decision:** **on-chain Styks read.** `get_twap_price(id:String) -> Option<U64>` is `Public` and
  contract-readable; `execute_rebalance` calls `get_twap_price("CSPRUSD")` directly. Guard staleness
  with `get_last_heartbeat() -> Option<U64>` (reject the cycle if heartbeat is stale — spec §8
  oracle-staleness guard). Keep signed-price-in only as an emergency fallback (not the default path).
- **Open item:** confirm the U64 fixed-point scale/decimals of the returned TWAP (read a live value
  in the manual test) so USD math and the per-action/daily caps are scaled correctly.
- **Consequence:** determines the price path in §4.1.3 and the Scout provenance labelling
  (Styks price = VERIFIED).

## D-004 — Gemini thinking budget for agent turns

- **Status:** DECIDED (provisional) — 2026-06-20.
- **Context:** Phase-0 smoke test confirmed `gemini-2.5-flash` + `responseSchema` returns valid
  structured JSON (HTTP 200). However the call reported `thoughtsTokenCount: 415` — Flash runs an
  internal thinking step by default, adding latency + token cost per turn.
- **Decision:** for the latency-sensitive Risk/Treasury turns, set
  `generationConfig.thinkingConfig.thinkingBudget: 0` (disable thinking) unless deliberation quality
  measurably suffers. Revisit if classification accuracy drops.
- **Consequence:** lower per-turn latency for the live demo loop; faster proposer–critic rounds.

## D-003 — Liquidity venue for the fast de-risk path

- **Status:** DECIDED — 2026-06-20 (with D-005).
- **Context:** fast de-risk = DEX swap sCSPR→stable on CSPR.trade. Testnet liquidity is thin
  everywhere; the direct sCSPR/WUSDT pool exists but is shallow (team-confirmed).
- **Decision:** **rely on the CSPR.trade Router's multi-hop routing** rather than seeding our own
  pool — the Router already routes around the shallow direct pair. Off-chain, **size every de-risk
  trade with MCP `pre_trade_analysis`** (shrink or NoOp when slippage exceeds the ceiling), and keep
  demo trades small relative to observed depth. On-chain `min_out` enforces the slippage ceiling a
  second time (spec §11). Revisit (seed a pool) only if demo trades can't clear acceptable slippage.
- **Consequence:** no pool-seeding work in Phase 0; slippage sizing is MCP-driven; the execution
  layer must pass the Router a path (or let the Router compute it) rather than hitting one pair.

---

## D-006 — Basis-point ABI width: `u16` → `u32` — DECIDED (2026-06-21, Phase 2)

- **Context:** spec §12.1 writes the bps fields (`max_slippage_bps`, `min/max_scspr_bps`,
  `AllocationBps`) as `u16`. Casper's CL type system has **no 16-bit integer** — `u16` does not
  implement `CLTyped`/`ToBytes`, so it cannot cross the contract ABI (compile error:
  `the trait bound u16: NamedCLTyped is not satisfied`).
- **Decision:** the contracts use **`u32`** for all bps fields. Values still live in `[0, 10000]`.
  The off-chain TS mirror keeps `number`, so nothing changes off-chain. Reference doc
  (`packages/shared/src/types/onchain-reference.md`) updated with the note.

## D-007 — On-chain receipt `deploy_hash` = 0, reconciled off-chain — DECIDED (2026-06-21, Phase 2)

- **Context:** `Receipt.deploy_hash` (§4.2.1) is the executed `TransactionV1` hash. The vault writes
  the receipt cross-contract **inside** that same transaction (TODO "for atomicity"), but a contract
  cannot read its own enclosing transaction hash on Casper 2.x at execution time.
- **Decision:** the vault records the receipt with `deploy_hash = [0u8; 32]`; the cryptographic core
  of the proof (`perception_hash` / `decision_hash`, computed off-chain over canonical JSON) is
  written verbatim and is what makes the log verifiable (spec §9.2). The **Phase-5 proof layer**
  reconciles the real `deploy_hash` via the emitted `RebalanceExecuted` event (cycle nonce → tx).
- **Consequence:** atomicity is preserved for the hashes that matter; `deploy_hash` is a
  post-finality annotation, not an on-chain-at-exec value.

## D-008 — AuditLog `admin` + `set_vault` to break the init cycle — DECIDED (2026-06-21, Phase 2)

- **Context:** the AuditLog gates `record` to the vault (cross-contract caller), but the vault's
  `init` needs the AuditLog address — a circular deploy-time dependency.
- **Decision:** `AuditLog::init(admin, agent)` takes the owner as `admin`; deploy order is
  **AuditLog → Vault → `audit_log.set_vault(vault)`** (admin-only, one-time). The agent is an
  authorized writer from `init` so direct agent records also work. Reflected in the deploy runbook.

## D-009 — WASM build toolchain: pinned nightly + missing scaffold — DECIDED (2026-06-21, Phase 2)

- **Context:** the Phase-1 Odra skeleton compiled + passed the 13 MockVM tests but had **never been
  `cargo odra build`-verified to WASM**. The first real WASM build surfaced four scaffold gaps the
  MockVM (native) path hid, none of which are contract-logic bugs:
  1. **No `no_std`.** `src/lib.rs` linked `std` into the wasm, colliding with
     `odra_casper_wasm_env`'s `panic_impl` (`duplicate lang item`). Fix: `#![cfg_attr(not(test),
     no_std)] / no_main` + `extern crate alloc;` (tests still build natively with `std`).
  2. **Wrong build bins.** `bin/build_{contract,schema}.rs` called `odra_build::build_*()` (an
     Odra-1.x spelling). Replaced with the 2.8 form (`#![no_std]` + `extern "Rust"` schema hooks);
     bins renamed to the `sentinel_contracts_build_*` convention cargo-odra resolves.
  3. **Missing `build.rs`.** Odra selects which contract a wasm exposes via the `odra_module` cfg,
     set by a crate-root `build.rs` (`odra_build::build()`) reading `ODRA_MODULE`. Without it **both
     contracts built byte-identical** wasm. Adding it makes cargo-odra compile once per contract →
     distinct `AuditLog.wasm` (~273 KB) / `SentinelVault.wasm` (~341 KB, opt+strip).
  4. **Unpinned nightly.** `rust-toolchain.toml` used bare `nightly`; current nightlies' `rust-lld`
     rejects the Casper host imports (`casper_revert`, …) as undefined symbols at wasm link time.
- **Decision:** pin **`nightly-2026-01-01`** (the nightly `cargo odra new` emits for Odra 2.8) and
  carry the scaffold above. Build deps: `cargo-odra 0.1.7`, `wasm-opt` (binaryen 130), `wasm-strip`
  (wabt 1.0.41) on `PATH`. `cargo odra build` now exits 0; the 13 MockVM tests still pass on the pin.
- **Consequence:** contracts are WASM-deploy-ready. The remaining Phase-2 items (Testnet deploy +
  associated-keys hardening) are unblocked but still require funded keys + signing on the host.

## D-010 — Phase-2 Testnet deploy + agent-account hardening — DONE (2026-06-21)

- **Deploy mechanism:** Odra Livenet host env via `packages/contracts/bin/livenet_deploy.rs` (feature
  `livenet`, dep `odra-casper-livenet-env`). Account 0 = owner key, account 1 = agent key.
  - **Node:** public Testnet RPC `https://node.testnet.casper.network/rpc` + open SSE
    `…/events` — **not** CSPR.cloud (the Livenet event watcher issues an unauthenticated GET, so the
    token-gated cspr.cloud stream 401s; the public node needs no auth). Chain `casper-test`.
  - **Order (D-008):** AuditLog → Vault → `set_vault`. Package hashes (in `.env` / `CLAUDE.md`):
    AuditLog `3f0d61e2…982db` (tx `034015f3…`), Vault `b44ac9cc…068f95` (tx `010e3168…`),
    `set_vault` tx `c3407329…`. Both packages verified on-chain (1 version each).
  - **Vault policy at init (owner-chosen, conservative demo):** per-action $50, daily $200 (micro-USD
    caps), sCSPR band 15–70 %, slippage 1 %. Tunable later via `set_policy`.
- **Associated-keys hardening (§4.3):** done as **one-shot session code** (`tools/key-hardening/`,
  casper-contract 5.1.1, `default-features=false` + own `wee_alloc`/panic handler; submitted with
  `casper-client put-transaction session … --transaction-runtime vm-casper-v1`, tx `877ed73f…`). A
  single atomic session — add owner key (w3) → set `key_management=3` → set `deployment=1` — so a revert
  leaves the account unchanged (no lock-out window); the owner account hash is embedded and was verified
  against `OWNER_PUBLIC_KEY`. **On-chain result:** owner key w3 + agent key w1, `deployment=1`,
  `key_management=3`. The agent signs `execute_rebalance` but cannot rekey/escalate; owner keeps recovery.
- **Note:** the agent account is still a Condor *legacy* account; the v1 key-management host functions
  apply cleanly to it.

## D-011 — casper-js-sdk ESM loader shim (no node_modules patch) — DECIDED (2026-06-21, Phase 3)

- **Context:** `packages/orchestrator` is ESM (`"type":"module"`, NodeNext). `casper-js-sdk@5.0.12`
  ships a UMD/CJS bundle with **no `import` condition** in its `exports`, so `import { RpcClient } from
  'casper-js-sdk'` resolves named bindings to `undefined` at runtime (the same breakage `tools/cspr-trade-mcp`
  patches with an ESM wrapper).
- **Decision:** load the SDK once via `createRequire(import.meta.url)('casper-js-sdk')` in
  `src/casper/sdk.ts` and re-export the values we use; types come from `export type` (erased at compile,
  so they don't hit the broken runtime resolution). No `node_modules` patch/postinstall needed — keeps the
  workaround in-repo and reinstall-safe.
- **Consequence:** all SDK use in the orchestrator imports from the shim, not the package directly.

## D-012 — Phase-3 perception layer: source seams + open live-validation items — DECIDED (2026-06-21)

- **Decision (architecture):** every network source is an injectable interface with a live impl **and** a
  static/scenario impl (`PriceFeed`/`ExchangeRateFeed`, `MarketDataProvider`, `BalanceReader`, `X402Signer`,
  `ArtifactStore`). The loop, the §15.3 demo scenario harness, and unit tests share one seam; the scenario
  price injection is therefore a first-class, **labelled** mechanism (`StaticPriceFeed` source
  `scenario-injection`), not a hack.
- **Decision (USD scale):** the off-chain layer reports prices in **USD micros (1e6)** (`PRICE_SCALE`),
  but the **raw Styks U64 is NOT micros** — see the live finding below.

### D-012 live-Testnet validation — RESOLVED (2026-06-22)

All four open items were exercised against live Testnet (probe scripts in
`packages/orchestrator/scripts/`, re-runnable). Code tightened to the confirmed shapes; full gate green
(typecheck/lint/format/build + 26 vitest).

1. **Styks off-chain TWAP read — READABLE (resolved).** Styks is an Odra contract: all storage lives in
   one dictionary named **`state`** (the Odra `STATE_KEY`). The CSPRUSD feed is the *sample ring buffer*
   `get_current_twap_store` = `List<Option<U64>>`; `get_twap_price` is its **simple average** (Styks docs).
   The dictionary item key is the Odra-derived `hex(blake2b256( u32_be(field_index) ++ CLString(id) ))`.
   On Testnet the CSPRUSD store is at **field index 4**, `last_heartbeat` (Odra `Var`, `Option<U64>`, unix
   **seconds**) at **index 3**. Live read of the derived key returned `[Some(307),Some(306),Some(308)]` →
   TWAP 307. `RpcOnChainReader.readTwap`/`readHeartbeat` now do this derivation+parse (still best-effort →
   `fallback-spot` on failure). `odraDictionaryItemKey` + `averageTwapFromBytes` are unit-checkable helpers.
   - **⚠️ Scale finding (cross-cutting) — RECONCILED in source (D-013):** raw CSPRUSD ≈ **307** while live
     CSPR/USD ≈ **$0.0023**, so the feed carries **5 decimals** (raw/1e5 ≈ $0.00307), **not** the 1e6
     micro-USD first assumed. Off-chain uses `STYKS_RAW_DECIMALS = 5`; the contract's `STYKS_TWAP_DECIMALS`
     was corrected **9 → 5** (the old 9 under-valued notional ~10⁴×, making the USD caps non-binding). See
     **D-013** (fix) and **D-014** — shipped on-chain via an upgradable redeploy (2026-06-22); new hashes
     vault `949a9c35…446f20`, AuditLog `95dd52c4…004712`.
   - **RPC auth note:** the cspr.cloud node RPC needs the access-token header (plain SDK handler 401s);
     the public node `node.testnet.casper.network/rpc` needs none. Point `NODE_RPC_URL` accordingly.
2. **CSPR.cloud REST shapes — RESOLVED.** Every endpoint wraps the body in `{ data, item_count?,
   page_count? }`. Corrections in `csprCloud.ts`: package→contract resolution is
   `/contracts?contract_package_hash=…` (the `/contract-packages/{h}` record carries **no** active hash);
   CEP-18 balances are `/accounts/{accountHash}/ft-token-ownership?contract_package_hash=…` (array, keyed
   by **account hash + package hash** — no contract-hash resolution needed for balances); the deploys feed
   is keyed by **public key** (account hash → `failed to parse public_key`) with fields `deploy_hash`,
   `timestamp`, `status`, `error_message` (no `type`). Verified: agent WUSDT balance `444509`.
3. **CSPR.trade MCP shapes — RESOLVED.** `get_quote` requires `{token_in,token_out,amount,type}` with
   `type ∈ {exact_in,exact_out}` and `amount` a token-unit string → JSON `{amountOut, executionPrice,
   midPrice, priceImpact, recommendedSlippageBps, …}`. `get_pair_details` takes `{pair}` = **pair package
   hash** → `{token0/1{packageHash,symbol,decimals}, reserve0/1, fiatPrice0/1 (null on Testnet)}`.
   `estimate_price_impact`/`estimate_slippage`/`analyze_trade` return **prose**, not JSON → the impact
   curve is derived from `get_quote.priceImpact`. `mcpClient.ts` rewritten accordingly. **Network caveat:**
   the public `mcp.cspr.trade` resolves a *different* token registry (its WCSPR/sCSPR hashes ≠ ours), so the
   orchestrator must use the **self-hosted** server (`CSPR_TRADE_NETWORK=testnet`) for our hashes.
4. **EIP-712 byte-match — PROVEN (digest); v2 envelope partial.** The hand-rolled encoder was wrong for
   Casper (it used a numeric `chainId`/`verifyingContract` EVM domain, 20-byte address right-align, and
   secp256k1). Live facts: the facilitator advertises **x402Version 2** (`/supported`, with per-network
   `feePayer`) and the Casper EIP-712 domain uses custom fields **`chain_name` (string) +
   `contract_package_hash` (bytes32)**, keccak256 hashing, addresses encoded as `keccak256(33-byte public
   key)`, and **ed25519** signing for our `01…` agent key. Resolved by depending on the official
   **`@casper-ecosystem/casper-eip-712`** package and reproducing its published
   `casper_transfer_with_authorization` digest **byte-for-byte**
   (`0x8868576c…604288`, now a unit test). `eip712.ts` rewritten around it with `Ed25519X402Signer`
   (Casper tag `01`); the x402 client/server default to **v2**; `VerifyResponse.invalidMessage` added.
   **Remaining (one item):** the facilitator's v2 *wire envelope* rejects with `invalid scheme:` (empty) —
   it reads a signature-scheme field we haven't located (object payloads + flat requirements confirmed; the
   digest/domain match is proven). Needs the facilitator's v2 payload schema/example before live `/settle`.

## D-013 — Styks TWAP scale reconciled in the vault (`STYKS_TWAP_DECIMALS` 9 → 5) — DECIDED (2026-06-22)

- **Context:** the D-012 live read pinned the Styks `get_twap_price("CSPRUSD")` U64 at **5 decimals**
  (raw ≈307 ≈ $0.00307; nearest clean power-of-ten to the live ≈$0.0023). The vault valued notional with
  `STYKS_TWAP_DECIMALS = 9` (`cspr_to_usd: micro_usd = amount × twap / 10^(9 + TWAP_DEC − 6)`), which
  under-valued every action ~10⁴×, i.e. the per-action ($50) and daily ($200) **USD caps were effectively
  non-binding** — the central hard invariant (spec §11) was silently defeated.
- **Decision:** set `STYKS_TWAP_DECIMALS = 5` in `vault.rs`. Verified with the MockVM suite (13/13): a
  100-CSPR action at the live scale (TWAP `2_000` = $0.02/CSPR, 5 dp) values to exactly $2, so the
  cap-breach / daily-cap / happy-path assertions hold under the corrected constant (test `TWAP` retuned
  `20_000_000` → `2_000` to keep the same $0.02 scenario; off-chain `STYKS_RAW_DECIMALS = 5` already agrees).
- **Consequence — resolved via redeploy (see D-014):** the original Testnet vault (`b44ac9cc…068f95`,
  D-010) carried the old constant in its WASM. An in-place Odra upgrade turned out to be **impossible**
  (the package was deployed Locked — D-014), so both contracts were redeployed as upgradable on 2026-06-22
  with the corrected constant. New hashes: vault `949a9c35…446f20`, AuditLog `95dd52c4…004712`.
  Re-confirm `STYKS_TWAP_DECIMALS` if Styks ever rotates the feed's published decimals.

## D-014 — Original contracts were Locked; redeployed both as upgradable — DECIDED (2026-06-22)

- **Context:** shipping the D-013 scale fix on-chain required either an in-place upgrade or a redeploy.
  CLAUDE.md / the README described the contracts as `odra_cfg_is_upgradable = true`, but on-chain query
  of package `b44ac9cc…068f95` returned **`lock_status: Locked`**. Root cause: `bin/livenet_deploy.rs`
  used `SentinelVault::deploy()` / `AuditLog::deploy()`, which Odra routes through `try_deploy` with
  `InstallConfig::new(false, true)` → `is_upgradable = false` (`odra-core` 2.8.1 `host.rs:227`); the
  `#[odra::module]` annotation never enabled it either. A Locked Casper package accepts no new contract
  versions, so `try_upgrade` cannot succeed.
- **Decision:** redeploy **both** contracts as upgradable. Patched `livenet_deploy.rs` to
  `deploy_with_cfg(…, InstallConfig::upgradable::<…HostRef>())` so future fixes are real Odra upgrades.
  Verified post-deploy: both new packages report `lock_status: Unlocked`. The existing AuditLog could
  have been reused (`set_vault` has no one-time guard despite its doc comment — it only checks
  `caller == admin`), but a clean upgradable pair was preferred; prior audit entries were discarded
  (none of value at Phase 3). Deploy txs: AuditLog `bf796d3b…`, vault `a2550fe1…`, set_vault `48a8e9a5…`.
- **Note:** the agent-account hardening (§4.3) is account-level, not contract-level, so it was unaffected
  by the redeploy — no re-hardening needed.
