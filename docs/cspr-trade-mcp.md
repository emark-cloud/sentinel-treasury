# CSPR.trade MCP — self-hosted (Testnet)

Stood up 2026-06-20 (Phase-0 item 2). Local install lives in `tools/cspr-trade-mcp/`.
Package: `@make-software/cspr-trade-mcp@0.6.0` (bin `cspr-trade-mcp`, 23/24 tools). DEX-only —
covers CSPR.trade swaps/quotes/liquidity/analysis. **Does NOT cover Wise Lending staking or Styks.**

## Run

```bash
cd tools/cspr-trade-mcp
npm install                 # runs patch-casper-esm.mjs (see below)
# HTTP (production transport for the orchestrator):
npm start                   # CSPR_TRADE_NETWORK=testnet, http on 127.0.0.1:3001  → /mcp , /health
# stdio (what we used to validate; what Claude Code / a spawned client uses):
CSPR_TRADE_NETWORK=testnet node ./node_modules/@make-software/cspr-trade-mcp/dist/index.js
```

- Public hosted endpoint also exists: `https://mcp.cspr.trade/mcp` (read-only market data is fine
  there; for build/sign/submit we self-host so **keys stay local** — "build remotely / sign locally").
- Signer (local-only, holds the agent key): run a second instance with `--signer` and
  `CSPR_TRADE_KEY_PATH=keys/agent/secret_key.pem`. Flow: `build_swap`/`build_approve_token`
  → `sign_deploy` → `submit_transaction`.

## Required patch (ESM/CJS interop) — `tools/cspr-trade-mcp/patch-casper-esm.mjs`

Out of the box the server **crashes on startup** under Node 20:
`SyntaxError: Named export 'Args' not found … casper-js-sdk is a CommonJS module`.
Cause: the MCP (ESM) does `import { Args, CLValue, … } from 'casper-js-sdk'`, but
`casper-js-sdk@5.0.12` ships only UMD bundles (`dist/lib.node.js`) with **no `import` condition**,
so Node's lexer can't see named exports. The patch (run as `postinstall`) writes an ESM wrapper
(`dist/esm-named.mjs`) that re-exports the named bindings via `createRequire`, and adds an `import`
condition to the package's `exports` map. Idempotent. Re-run after any reinstall.

## Transport note (this dev environment)

stdio works for one-shot validation (`node dist/index.js < requests.jsonl`). Long-lived
**HTTP/background launches get killed (exit 144 / signal 16) in this harness sandbox** — not a code
bug (a plain python listener survives; the MCP runs fine in the foreground). Run the HTTP server in
a normal terminal/host for the orchestrator; use stdio for in-process validation.

## Validated swap-construction path (item-2 exit criterion ✅)

`get_quote` → `build_approve_token` + `build_swap` produce two **unsigned `TransactionV1`** payloads
(Casper 2.x, matches our casper-js-sdk v5 stack), targeting protocols **by package hash**:

- **Approve**: `Stored` target = sCSPR package, `entry_point: approve`, args `spender`=router package
  (Key), `amount`=U256. Payment 5 CSPR.
- **Swap**: a **proxy-WASM `Session`** (module_bytes) whose named args are `package_hash`=router,
  `entry_point`="swap_exact_tokens_for_tokens", `args`=List<U8> (serialized
  amount_in/amount_out_min/path/to/deadline), `amount`/`attached_value`=U512 0. Payment ~30 CSPR.
  (Our on-chain Mode-A `execute_rebalance` will instead make a **direct** cross-contract call to the
  router — the proxy-WASM is only the off-chain build path.)

`slippage_bps` (default 300) → on-chain `amount_out_min` (`min_out`); `deadline_minutes` (default 20)
→ on-chain `deadline` U64. This resolves the abi-spike "deadline unit" open item.

## Live Testnet facts pulled via the MCP (2026-06-20)

- **De-risk route** (router pick): **sCSPR → WCSPR → WUSDT** (not sCSPR→WETH→WUSDT as the spike
  assumed). 500 sCSPR → 2.22129 WUSDT, price impact 0.61%, recommended slippage 62 bps.
- **Acquire route**: direct **CSPR → sCSPR** pool exists. 100 CSPR → 101.349 sCSPR, impact 0.30%,
  slippage 31 bps. Lets us obtain sCSPR for swap testing **without** the Wise `stake()` purse handoff.
- **Decimals**: sCSPR = 9, WUSDT = 6.
- Token id accepted by tools: symbol / name / contract hash. Amounts are human-readable strings.

## Key tools (23)

`get_tokens get_pairs get_pair_details get_quote get_currencies get_pair_price_history
get_token_price_history build_swap build_approve_token submit_transaction build_add_liquidity
build_remove_liquidity get_native_cspr_balance get_token_balance get_liquidity_positions
get_impermanent_loss get_swap_history get_portfolio_value get_position_status estimate_price_impact
estimate_slippage analyze_trade optimal_liquidity_amounts` (+ `sign_deploy` in `--signer` mode).
