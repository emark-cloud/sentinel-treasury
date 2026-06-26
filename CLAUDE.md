# CLAUDE.md — Sentinel Treasury

Guidance for Claude Code working in this repo. The authoritative source of truth is the three spec
docs; this file is the quick map. When in doubt, defer to `spec.md` / `design.md` / `resources.md`.

## What this is

**Sentinel Treasury** — an autonomous, self-auditing on-chain treasury manager for the **Casper
Agentic Buildathon 2026** (Casper **Testnet**, Casper 2.x / v2.1). A small team of AI agents runs a
continuous loop:

```
PERCEIVE ──▶ DECIDE ──▶ ACT ──▶ PROVE ──┐
   ▲                                     │
   └─────────────── loop ────────────────┘
```

- **Perceive:** Styks TWAP, CSPR.trade MCP market data, CSPR.cloud balances, one x402-paid premium signal.
- **Decide:** Scout/Risk/Treasury agents debate (proposer–critic), reach consensus or fall back to a rule engine.
- **Act:** the Vault contract executes a single capped rebalance under hard on-chain limits.
- **Prove:** a tamper-evident `Receipt` (hashes + facts + deploy_hash) is appended to the on-chain AuditLog.

The agent is the protagonist: it **observes, decides, acts with real money under hard on-chain limits, and proves each action.** Not a chatbot, not a passive yield router.

### The three managed buckets (target allocation, USD-normalized)

| Bucket | Asset | Role | Default Calm | Default Stressed |
|---|---|---|---|---|
| Risk-on (grow) | **sCSPR** (Wise Lending liquid staking) | staking yield | ~60% | ~20% |
| Risk-off (protect) | **csprUSD** (Sarson Funds CEP-18) | stable refuge | ~40% | ~80% |
| Working buffer | **CSPR** (native) | gas + swap input | fixed 50–100 CSPR, excluded from alloc math | — |

**Key wrinkle:** unstaking sCSPR→CSPR has a ~16h (7-era) unbonding delay. The **fast de-risk path is a
DEX swap** (sCSPR→csprUSD on CSPR.trade, instant); native unstake is reserved for deliberate full exits only.
Action selector rule: *speed → DEX; finality → unstake queue.*

## Locked decisions

- **Build priority:** **contracts-first** — get Vault + AuditLog solid on Testnet before agents/dashboard.
- **Repo:** **pnpm monorepo** (layout below).
- **Execution mode:** run an **ABI spike first**, then choose **Mode A** (atomic cross-contract calls inside
  `execute_rebalance`) vs **Mode B** (escrow-release: vault caps + releases, off-chain service calls the
  protocol) **per protocol**, based on confirmed Testnet ABIs. Record the choice in each receipt.
- **Integrations:** **real Testnet from the start** (no mock layer) → credentials + ABI spike are the first work.
- **USD conversion:** prefer on-chain Styks read inside `execute_rebalance`; fall back to signed-price-in
  (verify signature on-chain) if Styks isn't reliably readable on Testnet.

## Repo layout

```
sentinel-treasury/
├── packages/
│   ├── shared/        # TS types + JSON schemas + canonical-JSON blake2b hashing (the proof contract)
│   ├── contracts/     # Rust/Odra: SentinelVault + AuditLog (both odra_cfg_is_upgradable = true)
│   └── orchestrator/  # TS/Node: Scout/Risk/Treasury agents, data service, x402 client, execution service, rule engine
├── apps/
│   └── dashboard/     # Next.js dark command-center (9 panels, see design.md)
├── spec.md            # architecture, data shapes, demo flow — authoritative
├── design.md          # dashboard design (dark command-center)
├── resources.md       # libraries, endpoints, contract-hash blockers
├── TODO.md            # build sequence (contracts-first)
└── pnpm-workspace.yaml
```

`packages/shared` is **load-bearing**: off-chain `MarketSnapshot`/`Decision` types and the
`blake2b-256`-over-canonical-JSON hashing must exactly mirror the on-chain `Receipt` hashes. That equality
(`blake2b(snapshot) == receipt.perception_hash`, `blake2b(decision) == receipt.decision_hash`) is what makes
the audit log verifiable (spec §9). Use `blakejs` + `canonicalize`; sorted keys + fixed number formatting.

| Package | Governing spec section |
|---|---|
| `packages/contracts` | §4 (Vault + AuditLog), §11 (guardrails), §12.1 (on-chain models) |
| `packages/orchestrator` | §5 (perception), §6 (agents), §7 (decision logic), §8 (execution), §9 (proof) |
| `packages/shared` | §5.3, §6.3, §9.3, §12.2 (data models + hashing) |
| `apps/dashboard` | §10 + all of `design.md` |

## Tech stack & pinned versions

| Layer | Choice | Notes |
|---|---|---|
| Smart contracts | **Rust + Odra 2.8.x** | upgradable; feed `odra.dev/llms.txt` to the coding agent |
| Off-chain | **TypeScript / Node** | single language across agents/exec/data |
| LLM reasoning | **Gemini API** (Google AI Studio) | server-side only; **Gemini Flash tier** (`gemini-2.5-flash`) for fast Risk/Treasury turns; structured output via `responseSchema` + `responseMimeType: application/json`, parse-validate-retry |
| Chain SDK | **casper-js-sdk v5** (5.0.12+) | `TransactionV1` + `RpcClient` for Casper 2.x. **Not** legacy `DeployUtil`/Deploy API |
| Typed-data signing | **casper-eip-712** | x402 payment signatures |
| Payments | **x402** (facilitator `x402-facilitator.cspr.cloud`) | `casper:casper-test` network, `exact` scheme |
| Data | **CSPR.cloud** REST + **Streaming (SSE)** | balances, events, live dashboard feed |
| DEX/market | **CSPR.trade MCP** (self-hosted vs Testnet) | `market_data`, `pre_trade_analysis`, swap construction |
| Hashing | **blake2b-256** (`blakejs`) over canonical JSON (`canonicalize`) | reproducible across environments |
| Frontend | **Next.js / React**, **Recharts** | dark command-center per design.md |

## Hard invariants — the agent must NEVER break these (spec §11)

These are enforced **below the agent's reach** (in WASM / on the account), not just in off-chain code.
A fully compromised agent brain still **cannot**:

- Exceed the **per-action USD cap** or **daily USD cap** (denominated in USD, converted on-chain via Styks).
- Touch a **non-whitelisted** contract (whitelist mapping; non-whitelisted target reverts).
- Breach the **slippage ceiling** (off-chain MCP sizing + on-chain `min_out` revert — enforced twice).
- Push allocation outside **`[min_scspr_bps, max_scspr_bps]`** (checked post-action).
- **Rekey / escalate privileges / do key management** (agent key weight 1; key-management threshold 3; owner key weight 3).
- **Act while paused** (owner `pause(true)` kill switch).

Plus off-chain disciplines:
- **LLM output is clamped to the rule-engine envelope** — the model refines *within* the regime's legal band
  and the Risk agent's hard limits, never outside. No free-form addresses/amounts ever reach the chain.
- **Deterministic fallback floor:** any LLM failure / malformed output / no-consensus → pure-function rule
  engine; flagged `consensus:false, source:'fallback'` in the receipt.
- **AuditLog is append-only:** no update/delete entry points exist. Never add them.
- **x402 budget guard:** max one paid pull per loop iteration, hourly CSPR cap, duplicate-request
  suppression, no-progress backstop.
- **Provenance discipline:** every snapshot field is labelled VERIFIED | COMPUTED | ESTIMATED. Never present
  an estimate as fact.

## Conventions

- **Structured LLM I/O:** every agent turn returns strict JSON validated against a schema; on parse/schema
  failure → one repair retry → else fallback. Low temperature.
- **Hashing:** canonical JSON (sorted keys, fixed number formatting) → blake2b-256. The TS hash util in
  `packages/shared` and the on-chain hash check must agree byte-for-byte.
- **Secrets:** agent/owner keys never leave the execution host (CSPR.trade MCP's "build remotely / sign
  locally" model). API keys/tokens via env only; never commit. See the config registry below.
- **One action per loop iteration:** execute the single largest corrective action; converge over iterations.
- **Idempotency:** each cycle has a `cycle_id`; persist intended action → submitted `deploy_hash` → finality;
  reconcile in-flight deploys on restart (no double-execution).

## Key commands (placeholders — fill in as packages are scaffolded)

```bash
# contracts (packages/contracts) — Odra 2.8 needs nightly (box_patterns); pinned in rust-toolchain.toml
cargo +nightly test           # guardrail suite on the MockVM (13 tests; no network)
cargo odra build              # WASM build (needs cargo-odra installed)
cargo odra test               # WASM-backend tests
# (deploy to Testnet via Odra Livenet backend; record contract hashes in the registry below)

# orchestrator (packages/orchestrator)
pnpm --filter orchestrator dev
pnpm --filter orchestrator test

# dashboard (apps/dashboard) — Next.js 15 / React 19, dark command-center (Phase 6)
pnpm --filter @sentinel/dashboard dev         # dev server on http://localhost:3100
pnpm --filter @sentinel/dashboard build       # next build (static-renders the page)
pnpm --filter @sentinel/dashboard typecheck
```

## Config / env registry (fill in as the build progresses — see resources.md §9 & spec §13)

Values to obtain (none are public URLs; source via protocol Testnet UIs, cspr.live, docs/Discords, mentors):

```
# Our deployed contracts (UPGRADABLE multi-tenant vault redeploy, casper-test, 2026-06-26 — package hashes; D-015)
# Multi-tenant vault (no shares): deposit_cspr/deposit_token credit the depositor's own ledger slice;
# per-user set_my_policy refines within the owner's envelope; execute_rebalance(account, …) acts on one
# depositor's slice + policy; user-initiated withdraw/redeem pays out in-kind. Deposited/Redeemed events
# carry the depositor + amount. Fresh upgradable deploy (added per-account storage).
# Deployed via casper-js-sdk (packages/orchestrator/scripts/deploy-sharevault*.cjs) rather than odra's
# livenet backend — odra 2.8.1 pins casper-client 5.0.0 whose tx format the upgraded testnet node
# (protocol 2.2.2) rejects ("invalid pricing mode"); casper-js-sdk 5.0.12 speaks the current format.
# Gas note: testnet install cost has risen since D-014 — AuditLog needs 500 CSPR / Vault 700 CSPR payment
# caps (250/400 now hit "Out of gas"). deploy-sharevault.cjs carries the bumped caps.
VAULT_CONTRACT_HASH=5031341875f4f89629abe7aa748bfa20b0c6ee9c15e9d9910b3047dea9eff7a0     # deploy tx e92ff5e0…; init owner/agent + $50/$200 caps, 1% slip, 15–70% sCSPR band
AUDITLOG_CONTRACT_HASH=f8898e6a22590a8e32028d97771384fa54d0fc110cf297ed3f3afb2fecce63f3  # deploy tx 2699438a…; set_vault tx f8d8fe52… binds vault as writer
# Superseded D-014 share-vault deploy (casper-test, 2026-06-25):
#   VAULT_CONTRACT_HASH=513a28a4846d5c18ac354ff0483b45185780bf6e46f670ce19e926d10f059aa7  # deploy tx 664e963a…
#   AUDITLOG_CONTRACT_HASH=a1a2080d4079b81fd87a51218335d45426e7cd6f6491ccbdfe7a40911a15efdc  # deploy tx a597c982…
# Superseded D-013 deploy (pre-share-vault, casper-test, 2026-06-22):
#   VAULT_CONTRACT_HASH=949a9c359d12bf02a9f630c8eaeb1459348da6880e563d4ac278077a2f446f20  # deploy tx a2550fe1…
#   AUDITLOG_CONTRACT_HASH=95dd52c4fc07bb42ce8648f2cf74a8839244410de31b68045b96cb95cf004712  # deploy tx bf796d3b…
# Superseded (Locked / mis-scaled, abandoned 2026-06-22):
#   VAULT_CONTRACT_HASH=b44ac9cc720e30f0568c74612e984fc27b262dc7ea4ca4b0e1fa664ff3068f95
#   AUDITLOG_CONTRACT_HASH=3f0d61e2e1895f7810e59ffa168749058ac981bd5fa18a887a2eecdbc3d982db

# Keys
OWNER_PUBLIC_KEY=            # weight 3, key-management
AGENT_PUBLIC_KEY=            # weight 1, signs execute_rebalance
# (private keys live only on the execution host, never committed)

# External Testnet contract hashes/ABIs (the #1 blocker — ABI spike)
CSPR_TRADE_ROUTER_HASH=04a11a367e708c52557930c4e9c1301f4465100d1b1b6d0a62b48d3e32402867   # CSPR.trade Router (verified via CSPR.cloud); swap/approve ABI TBD in spike
WISE_LENDING_STAKING_HASH=baa50d1500aa5361c497c06b40f2822ebb0b5fce5b1c3a037ea628cb68d920f3  # Staked CSPR (sCSPR), site=testnet.wiselending.com; stake/unstake + exchange-rate read TBD in spike
WCSPR_HASH=3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e               # Wrapped CSPR — first hop in router swap paths
STABLE_TOKEN_HASH=287873e640fc0dbf3b7bc828a30e1d8ea857649a401b5b5f1ba29ab8bb741100        # WUSDT (Wrapped Tether) — Testnet stable refuge in place of csprUSD (D-005)
CSPRUSD_CEP18_HASH=          # N/A on Testnet — Sarson csprUSD is the intended mainnet asset only (D-005)
STYKS_PRICE_FEED_HASH=2879d6e927289197aab0101cc033f532fe22e4ab4686e44b5743cb1333031acc      # StyksPriceFeed (verified); get_twap_price("CSPRUSD")

# Services / endpoints
NODE_RPC_URL=https://node.testnet.cspr.cloud/rpc
CSPR_CLOUD_ACCESS_TOKEN=
GEMINI_API_KEY=             # Google AI Studio; GEMINI_MODEL=gemini-2.5-flash
X402_FACILITATOR_URL=https://x402-facilitator.cspr.cloud
CSPR_TRADE_MCP_ENDPOINT=
PREMIUM_ENDPOINT_URL=        # we run both ends; + price

# Dashboard depositor flow (apps/dashboard). Live reads need the CSPR.cloud token (server-side only,
# via the /api/vault + /api/position routes) + VAULT_ENTITY_HASH; absent these the dashboard runs the
# depositor UX against an in-memory demo vault (tagged `demo`). The browser submits signed deposit/
# redeem TransactionV1s to NEXT_PUBLIC_NODE_RPC_URL (public node, no token).
VAULT_ENTITY_HASH=5031341875f4f89629abe7aa748bfa20b0c6ee9c15e9d9910b3047dea9eff7a0   # vault package hash (D-015) — CSPR.cloud keys the vault's holdings by this
NEXT_PUBLIC_NODE_RPC_URL=https://node.testnet.casper.network/rpc
DASHBOARD_TWAP_MICROS=30700              # display CSPR/USD (micro-USD); on-chain Styks read is authoritative
DASHBOARD_SCSPR_STAKED=1052              # sCSPR rate numerator   (staked_cspr)  — display only
DASHBOARD_SCSPR_SUPPLY=1000              # sCSPR rate denominator (total_supply) — display only
```

## Top blockers to resolve first (resources.md)

1. **CSPR.trade router + Wise Lending staking Testnet ABIs** → decides Mode A vs Mode B (per protocol).
2. **Styks Testnet readability** → decides on-chain USD conversion vs signed-price-in.
3. **CSPR.cloud access token + sponsored x402 credits** → unblocks data + payments.
4. **Testnet liquidity for CSPR/csprUSD (or sCSPR/csprUSD)** → if thin, seed a pool or size demo trades to depth.

## Demo honesty note (spec §15.3)

The **market event** that triggers the demo is a labelled scenario injection into the perception layer
(Styks' 30-min heartbeat won't swing live on stage). **Everything downstream — the agents' reasoning, the
capped on-chain transaction, the x402 settlement, the receipt — is real on Testnet.** State this plainly in
the README honesty/status table. Scenario controls in the UI must be visibly tagged `demo` and styled apart
from real controls.

## Pointers

- `spec.md` — full technical & architecture spec (data shapes, enforcement flow, demo flow). **Authoritative.**
- `design.md` — dashboard design (dark command-center, 9 panels, motion discipline, semantic color).
- `resources.md` — annotated resource list, "values to obtain", and the top-blockers list.
- `TODO.md` — the contracts-first build sequence.
