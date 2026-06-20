# Sentinel Treasury — Build Resources

A categorized, annotated list of everything needed to build the project, mapped to the spec components. Verified against `docs.casper.network`, `github.com/casper-network`, and `casper.network/ai` (June 2026).

**Legend:** ⭐ = essential / load-bearing · 🔑 = requires an account, key, or access token · ⚠️ = value to obtain during build (not a public URL).

---

## 1. Hackathon, Community & Support

| Resource | URL | Why |
|---|---|---|
| Buildathon page (DoraHacks) | https://dorahacks.io/hackathon/casper-agentic-buildathon/detail | Submission, rules, deadline. |
| ⭐ CSPR.fans (community voting) | https://cspr.fans | Top-3 community-vote path bypasses judging — your social mobilization target. |
| ⭐ Casper Developers (Telegram) | https://t.me/CSPRDevelopers | Primary dev support channel during the build. |
| Casper Discord | https://discord.com/invite/caspernetwork | Support + announcements. |
| Casper Forum | https://forum.casper.network | Longer-form technical Q&A. |
| Casper Manifest (strategic thesis) | https://www.casper.network/news/manifest | "Trust layer for the agent economy" — language for your README narrative. |

---

## 2. Core Casper Documentation

| Resource | URL | Maps to |
|---|---|---|
| ⭐ Docs home | https://docs.casper.network/ | Everything. |
| ⭐ Developers section | https://docs.casper.network/developers | Build hub (contracts, SDKs, dapps). |
| Concepts (accounts, keys, gas) | https://docs.casper.network/concepts | Account model understanding. |
| ⭐ Accounts & associated keys / weights / action thresholds | https://docs.casper.network/concepts/design/casper-design (Accounts) + https://docs.casper.network/users/cli/transfers/multisig-deploy | §4.3 bounded-autonomy key model (agent weight 1, key-mgmt threshold 3). |
| Casper 2.0 unboxing | https://www.casper.network/unboxing-casper-2-0-casper-network | TransactionV1, multi-VM, Zug finality context. |
| Casper 2.1 unboxing | https://www.casper.network/unboxing-casper-2-1 | 8s block times, fee burning (latest Testnet). |
| ⭐ Testnet faucet | https://testnet.cspr.live/tools/faucet | Fund the vault/agent (once per account; make several accounts). |
| ⭐ Testnet explorer | https://testnet.cspr.live | §9 receipt verification (deploy_hash links). |
| Testnet node RPC (public) | https://node.testnet.casper.network/rpc | §8 transaction submission. |
| Casper Wallet | https://www.casper.network/get-started/casper-wallet/ | Key import, manual demo signing. |
| Quick-start tutorials | https://docs.casper.network/resources/quick-start | First contract deploy. |

---

## 3. Smart Contracts — Odra (Rust)

| Resource | URL | Maps to |
|---|---|---|
| ⭐ Odra docs | https://odra.dev/docs/ | §4 Vault + AuditLog contracts. |
| ⭐ Odra `llms.txt` (AI-discoverable) | https://odra.dev/llms.txt | Feed to your coding agent to generate/test contracts. |
| ⭐ Odra GitHub | https://github.com/odradev/odra | Source, examples, issues. |
| Casper backend / deploy (Livenet) | https://odra.dev/docs/backends/casper/ | Deploy straight to Testnet from code. |
| Odra modules (CEP-18 / CEP-78 / access control) | https://odra.dev/docs/ (Modules) | csprUSD/token interactions, role gating. |
| ⭐ Upgradable contracts (`odra_cfg_is_upgradable`) | https://odra.dev/docs/ (config) | §4 both contracts upgradable. |
| Cross-contract calls in Odra | https://odra.dev/docs/ (External contracts / `ContractRef`) | §8.4 Mode A atomic swap/stake calls. |
| Odra intro (developer portal) | https://developer.casper.network/odra-intro | Onboarding. |

> **Note:** the Vault's on-chain USD conversion (§4.1.3) and cap logic are pure Odra; the cross-contract calls into CSPR.trade/Wise Lending are the integration risk (§16) — read the "External contracts" Odra docs early.

---

## 4. SDK, Signing & Typed Data

| Resource | URL | Maps to |
|---|---|---|
| ⭐ casper-js-sdk (GitHub) | https://github.com/casper-ecosystem/casper-js-sdk | §8 build/sign `TransactionV1`. **Use v5.x+** for Casper 2.x `TransactionV1` + `RpcClient` (older `DeployUtil` is the legacy Deploy API). |
| ⭐ SDK docs (JS/TS) | https://docs.casper.network/developers/dapps/sdk/ | Client usage. |
| SDK client library usage | https://docs.casper.network/developers/dapps/sdk/client-library-usage | Concrete examples. |
| ⭐ casper-eip-712 (typed-data signing) | https://github.com/casper-ecosystem/casper-eip-712 | §5.2 x402 payment signatures. |
| casper-go-sdk (reference for x402 examples) | https://github.com/make-software/casper-go-sdk | The official x402 examples are Go; useful to read. |
| pycspr (if any Python tooling) | https://github.com/casper-network/casper-python-sdk | Optional. |

---

## 5. Node Access & On-Chain Data — CSPR.cloud

| Resource | URL | Maps to |
|---|---|---|
| ⭐ CSPR.cloud docs | https://docs.cspr.cloud | §3 Data Service (balances, events, submission). |
| 🔑 Access token (auth required on all endpoints) | https://docs.cspr.cloud (Authentication) | Needed for REST/Streaming/Node. |
| Testnet node via CSPR.cloud | https://node.testnet.cspr.cloud/rpc | Authenticated RPC. |
| REST API (accounts, balances, contracts) | https://docs.cspr.cloud/rest-api | Vault balance reads. |
| ⭐ Streaming API (SSE) | https://docs.cspr.cloud (Streaming) | §10 live deploy/transfer/event feed for the dashboard. |
| CSPR.cloud Agent Skill (`skill.md`) | https://cspr.cloud/skill.md | Installable skill for your coding agent. |

---

## 6. AI Toolkit — x402 Micropayments

| Resource | URL | Maps to |
|---|---|---|
| ⭐ x402 Facilitator API reference | https://docs.cspr.cloud/x402-facilitator-api/reference | §5.2 `/verify`, `/settle`; `casper:casper-test`, `exact` scheme. |
| ⭐ casper-x402 examples (server + client) | https://github.com/make-software/casper-x402/tree/master/examples | Reference implementation to adapt for the premium-data endpoint. |
| x402 user guide | https://github.com/make-software/casper-x402/blob/master/docs/user-guide.md | End-to-end flow. |
| Facilitator endpoint | https://x402-facilitator.cspr.cloud | Settlement target. Auth = the **CSPR.cloud access token** (already have it). |
| ~~Sponsored x402 credits~~ | via buildathon organizers | **NOT needed on Testnet** — see resolution below. Optional for mainnet. |

### x402 Testnet setup — RESOLVED (2026-06-20), sponsored credits not required

Confirmed from the `casper-x402` repo (`.env.testnet`, `.env.template`) + on-chain entry-point check:

- **Q: which CEP-18 payment token + faucet?** Use **WCSPR** — package
  `3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e` (= our existing `WCSPR_HASH`;
  contract `4b351800…`). It's the asset in the official testnet example (`ASSET_NAME=Wrapped CSPR`).
  Verified on-chain it implements the x402/EIP-3009 set: `transfer_with_authorization`,
  `receive_with_authorization`, `authorization_state`, `cancel_authorization`. **"Faucet" = `deposit`**
  (wrap our faucet CSPR → WCSPR). No special token funding needed.
- **Q: must we use the facilitator's designated token, or our own?** **The resource server chooses.**
  `ASSET_PACKAGE` is *server-side* config, advertised in `PaymentRequirements`; the facilitator settles
  whatever CEP-18 the server names (must support `transfer_with_authorization`). We run both ends, so we
  pick WCSPR.
- **Who pays settlement gas?** The **facilitator account** ("pays gas for every settled payment") — the
  hosted `x402-facilitator.cspr.cloud` provides it, gated only by the CSPR.cloud access token we already
  have. That hosted facilitator *is* the "sponsorship"; no separate credits to request.
- **Payer (client) needs:** a WCSPR balance + EIP-712 signing key (the agent key). Net: x402 is
  **unblocked on Testnet today**. Phase-3 todo is just wiring `PREMIUM_ENDPOINT_URL` + the x402 client.

---

## 7. AI Toolkit — MCP Servers

| Resource | URL | Maps to |
|---|---|---|
| ⭐ CSPR.trade MCP | https://mcp.cspr.trade | §5/§7 market data + `pre_trade_analysis` (proceed/caution/high_risk) + swap construction. |
| ⭐ CSPR.trade MCP — self-host on Testnet (npm) | https://mcp.cspr.trade (Self-Host / Agent SKILL.md) | Run against Testnet (keys stay local). |
| Casper MCP Server — setup | https://docs.cspr.cloud/agentic-tools/mcp-server | Chain queries (balances, deploys, contracts). |
| Casper MCP Server — GitHub | https://github.com/msanlisavas/casper-mcp | Source (.NET; stateless HTTP). |
| Alt: Casper Network MCP (Node) | https://github.com/Tairon-ai/casper-network-mcp | Wallet creation, transfers, staking via MCP. |
| MCP spec (concept) | https://modelcontextprotocol.io | Background on the protocol. |

---

## 8. AI Toolkit — Agent Skills

| Resource | URL | Maps to |
|---|---|---|
| ⭐ CSPR.click AI Agent Skill | https://docs.cspr.click/documentation/ai-agent-skills | §8 wallet connection, `TransactionV1` signing patterns, event handling, CSPR.cloud access. |
| CSPR.click docs (home) | https://docs.cspr.click | Frontend wallet integration (§10). |

---

## 9. DeFi Protocol Integrations (the managed assets)

> These are the live Testnet venues the agent acts on. **You must obtain each one's Testnet contract hash/ABI** — the principal Mode A/B decision (§8.4, §16).

| Protocol | URL | Maps to | Notes |
|---|---|---|---|
| ⭐ CSPR.trade DEX (swap venue) | https://cspr.trade | §8.3 de-risk swaps | Uniswap-V2-style AMM; Halborn-audited. Testnet beta. |
| ⭐ Wise Lending liquid staking (Testnet) | https://casper.wiselending.com/liquid-staking | §8.2 grow leg (CSPR→sCSPR) | ~16h unstake delay → use DEX swap for fast de-risk. |
| Liquid staking playbook | https://www.casper.network/get-started/casper-liquid-staking-open-beta-playbook | sCSPR stake/unstake flow | Testnet steps + metrics. |
| ⭐ Styks price oracle | https://styks.odra.dev | §5/§4 `get_twap_price("CSPRUSD")` | Free read; 30-min heartbeat; TWAP; TEE-signed. |
| Styks (Odra team / GitHub) | https://github.com/odradev | §4.1.3 signed-price fallback pattern | Confirm exact repo; mirrors `report_signed_prices`. |
| ⭐ csprUSD (Sarson Funds, Testnet) | https://www.casper.network/news/sarson-funds-csprusd-stablecoin-live-on-casper-network-testnet | §8 stable refuge (CEP-18) | Obtain Testnet token contract hash. |
| CSPR.trade open-beta playbook | https://www.casper.network/get-started/cspr-trade-open-beta-playbook | Swap/LP flows on Testnet | Useful for manual testing. |

### ⚠️ Values to obtain during build (not public URLs)
- CSPR.trade **router** Testnet contract hash + swap/approve entry-point ABI.
- Wise Lending **staking** Testnet contract hash + stake/unstake entry points + sCSPR exchange-rate read.
- **csprUSD** Testnet CEP-18 contract hash.
- **Styks** Testnet `StyksPriceFeed` contract hash + `get_twap_price` signature.
- **Vault** + **AuditLog** deployed contract hashes (yours, after deploy).
- Agent + owner public keys; CSPR.cloud access token; premium-endpoint URL/price.

*(Source these via the protocols' Testnet UIs + cspr.live, their docs/Discords, or the buildathon mentors.)*

---

## 10. Agent / LLM Layer

| Resource | URL | Maps to |
|---|---|---|
| ⭐ Gemini API docs | https://ai.google.dev/gemini-api/docs | §6 agent reasoning (Scout/Risk/Treasury). |
| 🔑 API key | https://aistudio.google.com/apikey | Server-side calls from the orchestrator. |
| Structured output (JSON) | https://ai.google.dev/gemini-api/docs/structured-output | §6.3 `responseSchema` + `responseMimeType`, parse-validate-retry. |
| Models overview (latency/cost tiers) | https://ai.google.dev/gemini-api/docs/models | `gemini-2.5-flash` fast tier for low demo latency. |
| Prompt engineering | https://ai.google.dev/gemini-api/docs/prompting-strategies | Role prompts + deterministic schema discipline. |

---

## 11. Frontend / Dashboard

| Resource | URL | Maps to |
|---|---|---|
| Next.js | https://nextjs.org/docs | §10 dashboard. |
| React | https://react.dev | UI. |
| CSPR.click (wallet connect SDK) | https://docs.cspr.click | Connect Casper Wallet in the dashboard. |
| Recharts / Chart.js | https://recharts.org · https://www.chartjs.org | Allocation panel, drift charts. |
| cspr.live Testnet (deep links) | https://testnet.cspr.live | Receipt "verify" links in the receipt feed. |

---

## 12. Utilities & Tooling

| Resource | URL | Maps to |
|---|---|---|
| blake2b (hashing) | https://www.npmjs.com/package/blakejs | §9.3 canonical-JSON receipt hashing. |
| canonical JSON | https://www.npmjs.com/package/canonicalize | Reproducible hashes across environments. |
| casper-client (CLI) | https://docs.casper.network/developers/cli/ | Manual deploys, key gen, contract queries. |
| Rust toolchain + wasm target | https://rustup.rs | Compile Odra contracts to WASM. |
| ⭐ Casper GitHub org | https://github.com/casper-network | Node, docs-redux, reference repos. |

---

## 13. Strategic / Reference (for README + narrative)

| Resource | URL | Why |
|---|---|---|
| Casper Manifest | https://www.casper.network/news/manifest | Agent-economy thesis language. |
| Casper roadmap | https://www.casper.network/roadmap | What's shipped vs. planned (honesty table). |
| Casper AI Toolkit page | https://www.casper.network/ai | Canonical list of the agent primitives + example use cases. |
| Odra "new standard" post | https://www.casper.network/news/odra-a-new-smart-contract-standard-for-casper | Background. |
| Liquid staking explainer | https://www.casper.network/news/liquid-staking | sCSPR mechanics for the README. |

---

## Quick map: spec component → must-have resources

- **Vault + AuditLog contracts (§4):** Odra docs/llms.txt/GitHub · cross-contract calls · associated-keys docs · Styks (on-chain price read).
- **Perception (§5):** Styks · CSPR.trade MCP · CSPR.cloud (REST/Streaming) · x402 facilitator API + casper-x402 examples + casper-eip-712.
- **Agents (§6):** Gemini API (docs/key/models/JSON structured output).
- **Execution (§8):** casper-js-sdk v5+ · CSPR.click skill · CSPR.trade router + Wise Lending staking (Testnet hashes/ABIs).
- **Proof (§9):** blakejs + canonicalize · testnet.cspr.live.
- **Dashboard (§10):** Next.js/React · CSPR.click · CSPR.cloud Streaming · Recharts.
- **Submission/votes:** DoraHacks page · CSPR.fans · Telegram/Discord.

---

## Top blockers to resolve first
1. **CSPR.trade router + Wise Lending staking Testnet ABIs** → decides §8.4 Mode A (atomic) vs Mode B (escrow). Ask in the Casper Developers Telegram if not in docs.
2. **Styks Testnet readability** → decides on-chain USD conversion vs. signed-price-in fallback (§4.1.3).
3. **CSPR.cloud access token** → unblocks data + x402 (the token also auths the hosted facilitator).
   ✅ Have it. **Sponsored x402 credits NOT needed on Testnet** — pay with WCSPR (`deposit`-wrapped
   faucet CSPR); hosted facilitator covers settlement gas. See §6 resolution.
4. **Testnet liquidity for CSPR/csprUSD (or sCSPR/csprUSD)** → if thin, plan to seed a pool or size demo trades to depth.
