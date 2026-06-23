# Sentinel Treasury

**An autonomous, self-auditing on-chain treasury manager for the Casper Agentic Buildathon 2026.**
Built on Casper **Testnet** (Casper 2.x / v2.1).

A small team of AI agents runs a continuous loop over a real on-chain treasury:

```
PERCEIVE ──▶ DECIDE ──▶ ACT ──▶ PROVE ──┐
   ▲                                     │
   └─────────────── loop ────────────────┘
```

- **Perceive** — Styks TWAP + CSPR.trade MCP market data + CSPR.cloud balances, plus one **x402-paid**
  premium risk signal. Every field is labelled `VERIFIED | COMPUTED | ESTIMATED`.
- **Decide** — Risk + Treasury agents (Gemini Flash) debate proposer–critic; consensus or a
  deterministic rule-engine fallback. The LLM only refines *within* the regime's legal band.
- **Act** — the Vault contract executes a **single capped rebalance** under hard on-chain limits.
- **Prove** — a tamper-evident `Receipt` (perception/decision hashes + `deploy_hash`) is appended to the
  on-chain append-only AuditLog. Anyone can recompute the hashes and verify.

The agent is the protagonist: it **observes, decides, acts with real money under hard on-chain limits,
and proves each action.** Not a chatbot, not a passive yield router.

---

## Honesty / status table

> The honest claim, stated plainly (spec §15.3): **the only simulated thing in the demo is the market
> event.** Styks' ~30-min TWAP heartbeat won't swing live on stage, so the trigger is a clearly-labelled
> scenario injected into the perception layer. **Everything downstream is real on Casper Testnet.**

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

## The three managed buckets

| Bucket | Asset | Role | Calm | Stressed |
|---|---|---|---|---|
| Risk-on (grow) | **sCSPR** (Wise Lending liquid staking) | staking yield | ~60% | ~20% |
| Risk-off (protect) | **WUSDT** (Testnet stable refuge for csprUSD) | stable refuge | ~40% | ~80% |
| Working buffer | **CSPR** (native) | gas + swap input | fixed 50–100 CSPR, excluded from alloc math | — |

**Key wrinkle:** unstaking sCSPR→CSPR has a ~16h (7-era) unbonding delay, so the **fast de-risk path is a
DEX swap** (sCSPR→WUSDT on CSPR.trade, instant). Native unstake is reserved for deliberate full exits.
*Selector rule: speed → DEX; finality → unstake queue.*

---

## Hard invariants (enforced in WASM / on the account, not just off-chain — spec §11)

A fully compromised agent brain still **cannot**:

- Exceed the **per-action** or **daily USD cap** (USD, converted on-chain via Styks).
- Touch a **non-whitelisted** contract (reverts).
- Breach the **slippage ceiling** (off-chain MCP sizing + on-chain `min_out` — enforced twice).
- Push allocation outside **`[min_scspr_bps, max_scspr_bps]`** (checked post-action).
- **Rekey / escalate privileges** (agent key weight 1; key-management threshold 3).
- **Act while paused** (owner `pause(true)` kill switch).

Off-chain disciplines: LLM output clamped to the rule-engine envelope · deterministic fallback floor ·
append-only AuditLog · x402 budget guard · per-field provenance.

---

## Demo walkthrough (spec §15.2)

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

## Architecture

```
sentinel-treasury/
├── packages/
│   ├── shared/        # TS types + JSON schemas + canonical-JSON blake2b hashing (the proof contract)
│   ├── contracts/     # Rust/Odra: SentinelVault + AuditLog (both upgradable)
│   └── orchestrator/  # TS/Node: agents, data service, x402, execution, proof, scenario harness, loop
└── apps/
    └── dashboard/     # Next.js dark command-center (9 panels)
```

The **perceive→decide→act→prove** loop is `packages/orchestrator/src/loop.ts` (`SentinelLoop`). It runs
the identical pipeline against live Testnet sources or the scenario harness — only the injected
`PerceptionSources` differ. The proof contract: `blake2b(MarketSnapshot) == Receipt.perceptionHash` and
`blake2b(Decision) == Receipt.decisionHash`, computed byte-for-byte the same in `packages/shared` (TS) and
in the contract (Rust).

### Tech stack

Rust + Odra 2.8 (upgradable contracts) · TypeScript/Node (agents, exec, data) · Gemini 2.5 Flash
(structured output) · casper-js-sdk v5 (`TransactionV1`) · x402 + casper-eip-712 (paid signals) ·
CSPR.cloud REST/SSE · CSPR.trade MCP · blake2b-256 over canonical JSON · Next.js / React.

---

## Deployed contracts (Casper Testnet — upgradable, 2026-06-22)

| Contract | Package hash |
|---|---|
| SentinelVault | `949a9c359d12bf02a9f630c8eaeb1459348da6880e563d4ac278077a2f446f20` |
| AuditLog | `95dd52c4fc07bb42ce8648f2cf74a8839244410de31b68045b96cb95cf004712` |

External Testnet integrations (CSPR.trade Router, Wise Lending staking/sCSPR, WCSPR, WUSDT, Styks price
feed) and the full config registry are in `CLAUDE.md` and `resources.md`.

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

Live runs need the credentials in the `CLAUDE.md` config registry (CSPR.cloud token, Gemini key, agent
key PEM on the execution host). Secrets are env-only and never committed; signing keys never leave the
execution host.

---

## Documents

- [`spec.md`](spec.md) — full technical & architecture spec (data shapes, enforcement flow, demo flow). **Authoritative.**
- [`design.md`](design.md) — dashboard design (dark command-center, 9 panels, motion + semantic color).
- [`resources.md`](resources.md) — annotated resources, "values to obtain", top blockers.
- [`docs/decisions.md`](docs/decisions.md) — the decision log (D-001 … D-017).
- [`TODO.md`](TODO.md) — the contracts-first build sequence.
