# Running & Deploying Sentinel Treasury

Two deployables:

| Component | Package | Hosts on | What it is |
|---|---|---|---|
| **Dashboard** | `apps/dashboard` | **Vercel** | Next.js UI + server API routes (depositor flow, live cycle/receipt proxy) |
| **Runner** | `packages/orchestrator` | **Railway** | Long-running daemon: the autonomous agent loop + HTTP/SSE feed |

The dashboard talks to the runner over `RUNNER_API_URL` (server-side proxy). Without it, the dashboard
runs the demo fallback — so the dashboard deploys and works standalone; the runner makes the agent live.

---

## 1. Local

The runner runs **built JS**, so it works on Node 20 (no Node 22 needed). The combined dev script
builds `shared` + `orchestrator` first, then runs both.

```bash
pnpm install
cp packages/orchestrator/.env.example packages/orchestrator/.env   # fill secrets + key paths
cp apps/dashboard/.env.local.example  apps/dashboard/.env.local     # RUNNER_API_URL=http://127.0.0.1:3002

pnpm dev          # runner on :3002 + dashboard on :3100 (Ctrl-C stops both)
# or separately:
pnpm runner       # build + start the runner
pnpm dashboard    # dashboard dev server
```

Open http://localhost:3100 — the top bar shows `agent live · next run …` and the center column animates
when the runner completes a cycle. Lower `RUNNER_INTERVAL_MS` (e.g. `120000`) to see cycles sooner, or use
the collapsed **Demo ▾** menu to trigger one on demand.

> The runner needs `AGENT_SECRET_KEY_PATH` pointing at the bounded agent PEM (and `OWNER_SECRET_KEY_PATH`
> to arm the circuit-breaker pause). Keep keys under `secrets/` (gitignored).

---

## 2. Dashboard → Vercel

1. New Project → import the repo. **Root Directory: `apps/dashboard`** (enable "Include files outside
   the root directory" — it needs the `@sentinel/shared` workspace package).
2. `apps/dashboard/vercel.json` already sets the install/build commands (builds `shared` then the app).
   Framework auto-detects as Next.js.
3. Set Environment Variables (from `apps/dashboard/.env.local.example`):
   - `RUNNER_API_URL` → the Railway runner's public URL (step 3).
   - `CSPR_CLOUD_ACCESS_TOKEN`, `VAULT_ENTITY_HASH`, `VAULT_CONTRACT_HASH`, `WISE_LENDING_STAKING_HASH`,
     `STABLE_TOKEN_HASH` for live vault reads (omit → demo vault).
   - `NEXT_PUBLIC_NODE_RPC_URL` + `NODE_RPC_URL` for the deposit/redeem submit path.
4. Deploy.

---

## 3. Runner → Railway

1. New Project → Deploy from the repo. Service **Root Directory: repo root** (so it sees the workspace).
2. `railway.json` already defines the build (`pnpm install` + build `shared` + `orchestrator`), the start
   command (`pnpm --filter orchestrator start`), and the healthcheck (`/status`). Nixpacks picks Node ≥20
   from `package.json` `engines`.
3. Set service Variables (from `packages/orchestrator/.env.example`): `CSPR_CLOUD_ACCESS_TOKEN`,
   `GEMINI_API_KEY`, `AGENT_PUBLIC_KEY`/`OWNER_PUBLIC_KEY`, the contract hashes, and the **signing keys**.
   - Railway has no filesystem for committed keys: either commit the PEMs to a **Railway Volume** and point
     `AGENT_SECRET_KEY_PATH`/`OWNER_SECRET_KEY_PATH` at the mount, or inject the PEM via a Secret File.
   - `PORT` is injected by Railway automatically — the runner binds to it (don't hard-set `RUNNER_PORT`).
4. Generate a public domain for the service → use that URL as the dashboard's `RUNNER_API_URL`.
5. (Optional) Persist the runner's `RUNNER_DATA_DIR` on a Railway Volume so the cycle journal / history /
   depositor registry survive redeploys (idempotency + a warm cycle feed on dashboard load).

---

## Notes

- **Honesty seam is preserved:** demo scenarios remain a labelled, optional trigger; live cycles are real
  on Testnet and verifiable (the receipt feed recomputes blake2b hashes; `/receipts` reads the on-chain
  AuditLog).
- **Startup safety:** the runner calls `reconcile()` before its first batch, so a redeploy mid-flight never
  double-submits a deploy.
- **Degraded modes:** no `GEMINI_API_KEY` → deterministic rule-engine decisions; no `CSPR_TRADE_MCP_ENDPOINT`
  → a neutral static market (cycles run, mostly NoOp). Both are safe, just less rich.
