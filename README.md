# Sentinel Treasury

**An autonomous, self-auditing on-chain treasury manager for the Casper Agentic Buildathon 2026.**
Built on Casper **Testnet** (Casper 2.x / v2.1).

Sentinel Treasury is a small team of AI agents that manages a real on-chain treasury without a human in
the loop. It watches the market, debates what to do, executes a capped rebalance under limits it
**physically cannot exceed**, and writes a cryptographic proof of every action to an on-chain audit log.

The agent is the protagonist: it **observes, decides, acts with real money under hard on-chain limits,
and proves each action.** Not a chatbot, not a passive yield router.

---

## The problem it solves

Letting an AI agent move real money is terrifying for two reasons: it might do something catastrophic,
and you can't tell afterwards *what it actually did versus what it claims it did.* Sentinel Treasury
answers both, structurally rather than by trust:

- **Bounded autonomy.** The agent acts with no human approval, but inside limits enforced in WASM on the
  vault contract — per-action cap, daily cap, contract whitelist, slippage ceiling, allocation bounds, a
  kill switch. A fully compromised agent brain *still* cannot drain the treasury or touch an unknown
  contract. The limits live **below the agent's reach**, not in the off-chain code it runs.
- **Verifiable action.** Every action emits a signed `Receipt` whose hashes anchor the agent's complete
  off-chain reasoning on-chain. Anyone can recompute the hashes and confirm *"the agent provably did X for
  reason Y"* — not *"the agent says it did X."* This closes the black-box gap.

The concrete job it does: **protect** capital by rotating into a stable asset when risk rises, and
**grow** it by staking into a yield-bearing asset when conditions are calm — continuously, and provably.

---

## How it works — the loop

```
PERCEIVE ──▶ DECIDE ──▶ ACT ──▶ PROVE ──┐
   ▲                                     │
   └─────────────── loop ────────────────┘
```

Each cycle runs the four stages below. The whole pipeline lives in
`packages/orchestrator/src/loop.ts` (`SentinelLoop`) and runs identically against live Testnet sources or
the demo scenario harness — only the injected data sources differ.

### 1 · Perceive — gather the world, label every fact

The **Scout** agent assembles a `MarketSnapshot` from four sources and tags every field with its
provenance — `VERIFIED` (read from chain), `COMPUTED` (derived from verified inputs), or `ESTIMATED`
(modelled / external). An estimate is never presented as fact.

| Signal | Source | Access |
|---|---|---|
| CSPR/USD TWAP | **Styks** `get_twap_price("CSPRUSD")` | On-chain read (free); ~30-min heartbeat |
| Spot price, liquidity depth, price impact | **CSPR.trade MCP** | `market_data`, `pre_trade_analysis` tools |
| Vault balances, recent events | **CSPR.cloud** REST / Streaming (SSE) | API |
| Premium volatility / risk signal | **Premium endpoint, x402-gated** | HTTP 402 → pay → 200 |

**The x402 paid pull (one visible machine-payment).** The premium signal sits behind an endpoint that
answers `HTTP 402 Payment Required`. The x402 client builds an `exact`-scheme payment for network
`casper:casper-test`, signs **EIP-712** typed data (`casper-eip-712`), calls the facilitator's `/verify`
then `/settle` at `x402-facilitator.cspr.cloud`, and retries with the `X-PAYMENT` proof header to get the
signal. The settlement is a real Testnet transaction. A **budget guard** allows at most one paid pull per
cycle, caps hourly CSPR spend, suppresses duplicate requests, and stops paying if a pull hasn't changed
the decision across several iterations.

### 2 · Decide — three agents debate, with a deterministic floor

Three LLM roles (Gemini 2.5 Flash, structured JSON, low temperature) run a bounded **proposer–critic**
debate, default max 2 rounds:

| Agent | Input | Output | Mandate |
|---|---|---|---|
| **Scout** | raw signals | `MarketSnapshot` | Gather, normalize, label provenance. No opinion on allocation. |
| **Risk** | `MarketSnapshot` | `RiskVerdict` | Classify the regime, score risk, set hard ceilings, **veto** unsafe proposals. |
| **Treasury** | snapshot + verdict | `AllocationProposal` | Propose a target allocation and the single concrete action toward it. |

```
1. Treasury proposes a target allocation + one action + rationale.
2. Risk reviews → APPROVE | REJECT(reasons).  Checks regime consistency, slippage,
   allocation bounds, caps, oracle-staleness/divergence sanity.
3. REJECT with rounds left → Treasury revises using Risk's reasons → back to 2.
4. APPROVE → Decision{ consensus: true, source: 'llm' }.
5. No consensus within the round budget → deterministic rule engine decides,
   flagged Decision{ consensus: false, source: 'fallback' } in the receipt.
```

The full transcript — every proposal, critique, and revision — is streamed to the dashboard and hashed
into the receipt, so the deliberation is both legible **and** auditable.

**Regimes and the rule engine.** Risk classifies the market into `Calm | Elevated | Stressed`. A
pure-function rule engine maps each regime to a legal allocation band:

| Regime | sCSPR (risk-on) | Stable (risk-off) |
|---|---|---|
| Calm | ~60% | ~40% |
| Elevated | ~40% | ~60% |
| Stressed | ~20% | ~80% |

This rule engine is not just the fallback — its bands are the **outer envelope the LLM is clamped to.**
The model may refine *within* the regime's legal band and Risk's hard limits, but a proposal outside that
range is intersected back inside before it can ever become an action. No free-form amount or address
reaches the chain.

**Sizing the action (USD-normalized).** All allocation math is done in USD using the Styks TWAP
(`price(sCSPR) = twap × sCSPR_exchange_rate`, which grows as staking rewards accrue; stable ≈ \$1.00).
The cycle computes `delta_usd` per bucket and executes the **single largest corrective action** —
one trade per cycle, converging to target over successive cycles. The amount is
`min(|delta_usd|, per_action_cap, Risk's max_action, day_remaining)`. Before any swap, the MCP
`pre_trade_analysis` sizes the trade to the slippage ceiling (shrink, or skip with a `NoOp` if even the
minimum is unacceptable).

### 3 · Act — one capped rebalance, enforced in WASM

The execution service builds a **`TransactionV1`** (casper-js-sdk v5), signs it with the bounded **agent
key** (never leaves the host), submits it to a Testnet node, and polls for finality. It calls the vault's
`execute_rebalance`, whose on-chain enforcement is the heart of bounded autonomy:

```
require(caller == agent)                                    // role gate
require(!paused)                                            // kill switch
require(whitelist[action.target])                           // contract whitelist
notional_usd = price_to_usd(amount, asset)                 // on-chain Styks read
require(notional_usd <= per_action_cap_usd)                // per-action cap
require(day_spent_usd + notional_usd <= daily_cap_usd)     // rolling daily cap
require(resulting_scspr_bps in [min_scspr_bps, max_scspr_bps])  // allocation bounds
// for swaps: min_out = quote × (1 - max_slippage_bps); router reverts if amount_out < min_out
```

Because caps are denominated in **USD and converted on-chain**, a hallucinated or malicious off-chain
`amount` is still bounded by USD notional. Each protocol runs in one of two modes, recorded per receipt:

- **Mode A — Atomic (preferred):** the vault performs the swap/stake via cross-contract calls *inside*
  `execute_rebalance`, so the cap checks and the asset move are one atomic transaction.
- **Mode B — Escrow-release (fallback):** if cross-contract integration is impractical for a protocol on
  Testnet, the vault validates + caps + releases the exact approved amount to the agent's execution path,
  which performs the protocol call and reports the `deploy_hash` back. Caps are still enforced at release.

**The de-risk wrinkle:** unstaking sCSPR→CSPR has a ~16h (7-era) unbonding delay, too slow to defend with.
So the **fast de-risk path is a DEX swap** (sCSPR→stable on CSPR.trade, instant); native unstake is
reserved for deliberate full exits. *Selector rule: speed → DEX; finality → unstake queue.*

### 4 · Prove — bind the reasoning to the action

- **On-chain (AuditLog):** a compact, **append-only** `Receipt` — `perception_hash`, `decision_hash`,
  pre/post allocation, amount, `notional_usd`, target, `deploy_hash`, result, TWAP. Cheap, permanent,
  tamper-evident. There are no update or delete entry points, by design.
- **Off-chain (artifact store):** the full `MarketSnapshot` JSON and full debate transcript.

The two are bound cryptographically: `blake2b(MarketSnapshot) == Receipt.perception_hash` and
`blake2b(Decision) == Receipt.decision_hash`, computed byte-for-byte identically in `packages/shared`
(TypeScript) and in the contract (Rust) — `blake2b-256` over canonicalized JSON (sorted keys, fixed number
formatting). **Anyone can verify a cycle:**

```
1. Read Receipt(action_id) from the AuditLog (on-chain).
2. Fetch the off-chain snapshot + decision for that action_id.
3. Recompute the blake2b hashes; assert they equal the on-chain hashes.
4. Open receipt.deploy_hash on cspr.live → confirm the token movement matches post_alloc_bps.
```

In the dashboard, the **verify** button does exactly this in the browser.

---

## The three managed buckets

| Bucket | Asset | Role | Calm | Stressed |
|---|---|---|---|---|
| Risk-on (grow) | **sCSPR** (Wise Lending liquid staking) | staking yield | ~60% | ~20% |
| Risk-off (protect) | **WUSDT** (Testnet stable refuge for csprUSD) | stable refuge | ~40% | ~80% |
| Working buffer | **CSPR** (native) | gas + swap input | fixed 50–100 CSPR, excluded from alloc math | — |

> The intended risk-off asset is Sarson Funds **csprUSD**; it isn't reliably available on Testnet, so the
> deployed build uses **WUSDT** as the stand-in stable refuge (decision D-005). Swaps route through the
> CSPR.trade Router rather than the shallow direct pool, so the router finds the best path.

---

## Hard invariants — what the agent can NEVER do (enforced in WASM / on the account)

These live below the agent's reach. A fully compromised agent brain still **cannot**:

- Exceed the **per-action** or **daily USD cap** (USD, converted on-chain via Styks).
- Touch a **non-whitelisted** contract (reverts).
- Breach the **slippage ceiling** (off-chain MCP sizing + on-chain `min_out` — enforced twice).
- Push allocation outside **`[min_scspr_bps, max_scspr_bps]`** (checked post-action).
- **Rekey / escalate privileges** — the agent key has weight 1; key-management threshold is 3, so only the
  owner (weight 3) can add/remove keys. The agent can transact alone but can never manage keys.
- **Act while paused** — owner `pause(true)` is a hard kill switch.

Off-chain disciplines reinforce these: LLM output clamped to the rule-engine envelope · deterministic
fallback floor on any LLM failure / no-consensus · append-only AuditLog · x402 budget guard ·
per-field provenance · oracle-staleness guard · idempotent cycles (a `cycle_id` tracks intended action →
`deploy_hash` → finality, reconciled on restart so nothing executes twice) · a circuit breaker that
auto-pauses after repeated reverts.

---

## The contracts (Rust / Odra, both upgradable)

**`SentinelVault`** — custody + policy enforcement + execution. Holds CSPR / sCSPR / stable; stores the
owner-settable policy (caps, slippage ceiling, whitelist, allocation bounds). Owner-only entry points:
`deposit_*`, `withdraw`, `set_policy`, `set_agent`, `set_whitelist`, `pause`. The single agent-only entry
point is `execute_rebalance(action)` — the enforcement flow shown above. Views expose balances, policy,
and remaining daily budget.

**`AuditLog`** — append-only receipt store. `record(receipt)` is callable only by the vault; reads
(`get`, `range`, `latest`, `count`) are open to the UI and any verifier. No mutation entry points exist —
that absence is what makes the log tamper-evident.

**Defense-in-depth via Casper associated keys:** beyond the vault's WASM caps, the agent's signing account
uses native action thresholds (`deployment_threshold = 1`, `key_management_threshold = 3`) so the agent's
blast radius is bounded at the account level too.

---

## Honesty / status table

> The honest claim, stated plainly: **the only simulated thing in the demo is the market event.** Styks'
> ~30-min TWAP heartbeat won't swing live on stage, so the trigger is a clearly-labelled scenario injected
> into the perception layer. **Everything downstream is real on Casper Testnet.**

| Element | Status | How it's real / where it's injected |
|---|---|---|
| Market event (price shock / liquidity crunch) | 🟡 **Injected** (labelled `demo`) | `packages/orchestrator/src/scenario/scenarios.ts`; the injected price feed is sourced `scenario-injection` → the Scout records its provenance **ESTIMATED**, never VERIFIED. The dashboard's scenario controls are dashed-amber and tagged `demo`. |
| Vault balances + sCSPR exchange rate | 🟢 **Real** | Read from chain (CSPR.cloud + on-chain `staked_cspr/total_supply`); never injected. |
| Agent reasoning (Risk + Treasury debate) | 🟢 **Real** | Gemini 2.5 Flash, structured JSON, parse-validate-retry → deterministic fallback. |
| Decision → single capped action | 🟢 **Real** | Sized deterministically from USD deltas ∩ caps ∩ pool depth; **no free-form amount reaches the chain.** |
| x402 premium pull | 🟢 **Real settlement** | EIP-3009 `TransferWithAuthorization` → `x402-facilitator.cspr.cloud` `/verify` + `/settle`. Only the signal *value* is the injected market event. |
| `execute_rebalance` transaction | 🟢 **Real on Testnet** | `TransactionV1` signed by the bounded agent key; finalized; live `deploy_hash`. |
| On-chain caps / whitelist / allocation bounds | 🟢 **Real, enforced in WASM** | Enforced below the agent's reach; a fully compromised agent brain still cannot breach them. |
| Receipt + AuditLog entry | 🟢 **Real on Testnet** | Written cross-contract atomically by the vault; append-only; hash-verifiable. |
| Dashboard cycle data | 🟡 **Demo seam** | `apps/dashboard/lib/scenario.ts` generates cycles from the **real** `@sentinel/shared` shapes + real blake2b hashing, so the receipt **verify** button recomputes genuine hashes in the browser. Live CSPR.cloud SSE + CSPR.click owner-signing drop in behind the same `CycleSource` interface. |

---

## Demo walkthrough

1. Vault funded on Testnet (sCSPR + WUSDT + CSPR), allocation panel at ~60/40.
2. Inject a **price-shock** scenario (labelled `demo`) — price drop + widening TWAP/spot divergence.
3. **Perceive** — Scout pulls Styks + MCP data and makes one x402-paid premium pull (meter ticks).
4. **Decide** — Risk flags `Stressed`; Treasury proposes ~20/80; Risk approves → consensus.
5. **Act** — vault `execute_rebalance` swaps sCSPR→WUSDT within caps + slippage bound; live `deploy_hash`.
6. **Prove** — receipt written; click **verify** → hashes match + cspr.live shows the movement.
7. Reverse the scenario (**calm**) → agent grows back toward 60/40 → second receipt.
8. Press **Pause** (owner) → the agent is halted → unpause.

The **3-second beat**: shock → debate → `CONSENSUS` → live `deploy_hash` → green `Receipt #N ✔ on-chain`.

---

## Dashboard

A dark "command-center" (Next.js 15 / React 19, dev server on `http://localhost:3100`) that visualizes a
live cycle: the **allocation** panel (target vs actual sCSPR/stable/CSPR), the **debate** stream (Scout/
Risk/Treasury turns with a consensus badge or fallback flag), the **decision** card (regime, target bps,
the concrete action, expected slippage), the **action** card (the `TransactionV1`, live `deploy_hash`, a
cspr.live link), the **receipt feed** with one-click **verify** (recomputes hashes in-browser), the
**guardrail** panel (caps used/remaining, whitelist, slippage ceiling, agent-key weights, owner **Pause**),
and the **x402 meter** (paid pulls, CSPR spent, last settle tx). The top bar carries the loop-stage
visualizer and the `demo`-tagged scenario controls. Full design language is in `design.md`.

---

## Architecture

```
sentinel-treasury/
├── packages/
│   ├── shared/        # TS types + JSON schemas + canonical-JSON blake2b hashing (the proof contract)
│   ├── contracts/     # Rust/Odra: SentinelVault + AuditLog (both upgradable)
│   └── orchestrator/  # TS/Node: Scout/Risk/Treasury agents, data + x402 + execution + proof
│                      #          services, rule engine, scenario harness, and the perceive→…→prove loop
└── apps/
    └── dashboard/     # Next.js dark command-center
```

`packages/shared` is **load-bearing**: its off-chain `MarketSnapshot` / `Decision` types and its
blake2b-over-canonical-JSON hashing must mirror the on-chain `Receipt` hashes byte-for-byte — that equality
is what makes the audit log verifiable.

**Tech stack:** Rust + Odra 2.8 (upgradable contracts) · TypeScript/Node (agents, exec, data) · Gemini 2.5
Flash (structured output via `responseSchema`) · casper-js-sdk v5 (`TransactionV1` + `RpcClient` for Casper
2.x) · x402 + casper-eip-712 (paid signals) · CSPR.cloud REST/SSE · CSPR.trade MCP · blake2b-256 over
canonical JSON · Next.js / React + Recharts.

---

## Deployed contracts (Casper Testnet — upgradable, 2026-06-22)

| Contract | Package hash |
|---|---|
| SentinelVault | `949a9c359d12bf02a9f630c8eaeb1459348da6880e563d4ac278077a2f446f20` |
| AuditLog | `95dd52c4fc07bb42ce8648f2cf74a8839244410de31b68045b96cb95cf004712` |

External Testnet integrations (CSPR.trade Router, Wise Lending staking/sCSPR, WCSPR, WUSDT, Styks price
feed) and the full config / env registry live in `CLAUDE.md` and `resources.md`.

---

## Running it

```bash
# install (pnpm monorepo)
pnpm install

# contracts (packages/contracts) — Odra 2.8 needs the pinned nightly (rust-toolchain.toml)
cargo +nightly test           # guardrail suite on the MockVM (13 tests, no network)
cargo odra build              # WASM build (needs cargo-odra)

# orchestrator (packages/orchestrator)
pnpm --filter orchestrator test          # 104 vitest tests (offline; scenario + loop end-to-end)
pnpm --filter orchestrator typecheck

# dashboard (apps/dashboard) — dark command-center
pnpm --filter @sentinel/dashboard dev     # http://localhost:3100
pnpm --filter @sentinel/dashboard build
```

Live runs need the credentials in the `CLAUDE.md` config registry (CSPR.cloud token, Gemini key, agent key
PEM on the execution host). Secrets are env-only and never committed; signing keys never leave the
execution host.

---

## Documents

- [`spec.md`](spec.md) — full technical & architecture spec (data shapes, enforcement flow, demo flow). **Authoritative.**
- [`design.md`](design.md) — dashboard design (dark command-center, panels, motion + semantic color).
- [`resources.md`](resources.md) — annotated resources, "values to obtain", top blockers.
- [`docs/decisions.md`](docs/decisions.md) — the decision log (D-001 … D-017).
- [`TODO.md`](TODO.md) — the contracts-first build sequence.
