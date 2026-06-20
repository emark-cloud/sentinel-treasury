# Phase 0 Runbook — Prerequisites & Spikes

Concrete steps for the Phase-0 checklist in `TODO.md`. Items marked 👤 require your accounts /
credentials and must be done by you; the rest is structuring + spike work. As values come in, drop
them into `.env` (copy from `.env.example`) and record decisions in `docs/decisions.md`.

---

## 0. Install the missing tools (one-time)

Already present: `cargo` (+ wasm32 target), `node` v20, `pnpm` v9.

```bash
# casper-client (key-gen, manual deploys, contract queries for the ABI spike)
cargo install casper-client

# cargo-odra (Phase 2 contracts) — install when you reach Phase 2 if you prefer
cargo install cargo-odra
```

> `cargo install casper-client` compiles from source and can take several minutes. Ask Claude to
> run it for you, or run it yourself with `! cargo install casper-client`.

---

## 1. 👤 Casper Testnet accounts (owner + agent)

```bash
mkdir -p keys/owner keys/agent
casper-client keygen keys/owner   # -> secret_key.pem, public_key.pem, public_key_hex
casper-client keygen keys/agent
```

- Copy the two `public_key_hex` values into `.env` as `OWNER_PUBLIC_KEY` / `AGENT_PUBLIC_KEY`.
- Set `OWNER_SECRET_KEY_PATH` / `AGENT_SECRET_KEY_PATH` to the `secret_key.pem` paths.
- Fund each at the faucet (once per account; make several accounts if you need more):
  https://testnet.cspr.live/tools/faucet
- Confirm balances on https://testnet.cspr.live.

> The owner key will get weight 3 / key-management threshold 3, the agent key weight 1
> (Phase-2 associated-keys hardening). Keep both `secret_key.pem` files on the host only — they
> are gitignored.

## 2. 👤 CSPR.cloud access token

- Get a token from https://docs.cspr.cloud (Authentication). Required on all REST/Streaming/Node
  endpoints. Put it in `.env` as `CSPR_CLOUD_ACCESS_TOKEN`. Test:

```bash
curl -s -H "Authorization: $CSPR_CLOUD_ACCESS_TOKEN" \
  "https://api.testnet.cspr.cloud/accounts/<your-owner-public-key>" | head
```

## 3. 👤 Gemini API key

- From Google AI Studio: https://aistudio.google.com/apikey → `.env` `GEMINI_API_KEY`.
- Model for Risk/Treasury: `gemini-2.5-flash` (fast tier; verify latest naming in AI Studio).
- Use structured output (`responseMimeType: application/json` + `responseSchema`) to keep the
  strict-JSON / parse-validate-retry discipline (spec §6.3).

## 4. 👤 Sponsored x402 credits

- Request early from the buildathon organizers (DoraHacks page / Casper Developers Telegram). Free
  on-chain x402 usage for entrants.

---

## 5. 🔒 ABI spike — confirm Testnet hashes + entry-point ABIs

For each protocol: find the Testnet contract hash (via the protocol's Testnet UI + cspr.live), then
inspect its entry points and exercise one call manually. Record findings in `docs/decisions.md`
(D-001, D-002) and the hashes in `.env`.

Inspect a contract's entry points (named-key / state query):

```bash
# Get a contract package's state (entry points, named keys) via RPC
casper-client query-global-state \
  --node-address "$NODE_RPC_URL" \
  --state-root-hash $(casper-client get-state-root-hash --node-address "$NODE_RPC_URL" -r 5 | jq -r '.result.state_root_hash') \
  --key hash-<CONTRACT_HASH>
```

Targets to confirm:

- [ ] **CSPR.trade router** — swap + approve entry points; do a manual swap. → `CSPR_TRADE_ROUTER_HASH`
  - Source: https://cspr.trade (Testnet) + open-beta playbook. Decides D-001 (router Mode A vs B).
- [ ] **Wise Lending staking** — stake/unstake entry points + **sCSPR→CSPR exchange-rate read**;
  do a manual stake. → `WISE_LENDING_STAKING_HASH`
  - Source: https://casper.wiselending.com/liquid-staking + playbook. Decides D-001 (staking mode).
- [ ] **csprUSD CEP-18** — confirm `transfer` / `transfer_from`. → `CSPRUSD_CEP18_HASH`
- [ ] **Styks** `get_twap_price("CSPRUSD")` — confirm it's **readable on-chain** (contract-to-contract).
  → `STYKS_PRICE_FEED_HASH`. Decides D-002 (on-chain read vs signed-price-in).
  - Source: https://styks.odra.dev.

If a hash/ABI isn't in the docs, ask in the Casper Developers Telegram (https://t.me/CSPRDevelopers).

---

## 6. 🔒 Decide & record Mode A vs Mode B + USD-conversion approach

Once the spike data is in, fill D-001 / D-002 in `docs/decisions.md` and mirror the chosen hashes
into the `CLAUDE.md` config registry.

---

## 7. CSPR.trade MCP — self-host against Testnet

- Set up per https://mcp.cspr.trade (Self-Host / Agent SKILL.md). Keys stay local
  ("build remotely / sign locally"). Validate the swap-construction path. → `CSPR_TRADE_MCP_ENDPOINT`.

## 8. Testnet liquidity check (D-003)

- Check pool depth for CSPR/csprUSD (and/or sCSPR/csprUSD) via the CSPR.trade MCP `market_data` /
  the DEX UI. If thin: plan to seed a pool or size demo trades to depth. Record in D-003.

---

## Phase-0 exit criteria

- [ ] owner + agent keypairs funded; public keys in `.env`
- [ ] CSPR.cloud token + Gemini key in `.env`; x402 credits requested
- [ ] all four external Testnet hashes confirmed + manually exercised; in `.env`
- [ ] D-001, D-002, D-003 decided and recorded; CLAUDE.md registry updated
- [ ] CSPR.trade MCP up; swap-construction validated
