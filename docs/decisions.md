# Decisions — Sentinel Treasury

Append-only record of locked technical decisions. Each entry: context → decision → consequence.
Phase-0 decisions feed the `CLAUDE.md` config registry. Status legend: `PENDING` (awaiting ABI
spike / data) · `DECIDED` · `REVISITED`.

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
  `get_amounts_out(amount_in, path)`. Path for sCSPR→WUSDT is multi-hop via WETH:
  `[sCSPR, WETH, WUSDT]` (only common pool intermediary — see D-003).
- **Decision (Wise Lending staking):** **Mode A (atomic), with a caveat to verify.** `stake()`,
  `unstake(scspr_amount:U256)`, `claim()` are all `Public`. **Open item:** `stake()` takes no amount
  arg and is payable — CSPR is supplied via a purse / the contract's loose-token pool
  (`__contract_main_purse`, `add_loose_tokens`/`restake_loose_tokens`). Must confirm the
  purse-handoff pattern from Odra before committing; if cross-contract purse passing is awkward,
  fall back to **Mode B** for the stake (grow) leg only. The de-risk (swap) leg stays Mode A.
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
