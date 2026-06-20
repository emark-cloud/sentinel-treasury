# ABI Spike — Testnet entry points (2026-06-20)

Read via `casper-client query-global-state` against `node.testnet.casper.network/rpc`. All four
targets are legacy `Contract` stored values (not Casper-2.x `AddressableEntity`), so entry points
are inline. Decisions derived from this: D-001 (Mode A), D-002 (on-chain Styks), D-003/D-005 (WUSDT
via routing). Re-run with `python3 /tmp/abi_spike.py` (env: `CSPR_CLOUD_ACCESS_TOKEN`).

## Package → active contract hashes

| Contract | Package hash | Active contract hash |
|---|---|---|
| CSPR.trade Router | `04a11a36…02867` | `c93d6c443d4c42e4a5a01f0157de89863a9048ceeb574028ce8fb28f02feaef0` |
| sCSPR / Wise staking | `baa50d15…20b3` | `e390f51e1312d01d8c5d93d5f4185997b2f02f1f1c7fbebe828812a83ccdcb31` |
| Styks PriceFeed | `2879d6e9…1acc` | `3f1efb55d4795bba39ab8c204b554ea16638d0ab3fe58a01e16190e7103f5a0b` |
| WUSDT (Wrapped Tether) | `287873e6…1100` | `19ae76f8458fb449bb9809a17729f0b2f9aef6cb404993456cf69a1ff306681f` |
| WETH (swap intermediary) | `711f2feb…af05` | _(resolve when needed)_ |

> Contract hashes can change on upgrade (all are upgradable). Resolve package→contract at runtime
> via CSPR.cloud `/contracts?contract_package_hash=…`; bind to the **package** hash in config.

## CSPR.trade Router — Mode A (atomic swap)

```
swap_exact_tokens_for_tokens(amount_in:U256, amount_out_min:U256, path:List<Key>, to:Key, deadline:U64) -> List<U256>
swap_exact_cspr_for_tokens(amount_out_min:U256, path:List<Key>, to:Key, deadline:U64) -> List<U256>
swap_exact_tokens_for_cspr(amount_in:U256, amount_out_min:U256, path:List<Key>, to:Key, deadline:U64) -> List<U256>
swap_tokens_for_exact_tokens / swap_cspr_for_exact_tokens / swap_tokens_for_exact_cspr (exact-out variants)
get_amounts_out(amount_in:U256, path:List<Key>) -> List<U256>   # sizing / quote
get_amounts_in(amount_out:U256, path:List<Key>) -> List<U256>
add_liquidity / add_liquidity_cspr / remove_liquidity / remove_liquidity_cspr
quote / get_amount_in / get_amount_out / factory_address() / wcspr()
```
- **De-risk (sCSPR→stable):** `approve(router, amount_in)` on sCSPR, then
  `swap_exact_tokens_for_tokens(amount_in, amount_out_min, [sCSPR, WETH, WUSDT], vault, deadline)`.
- `amount_out_min` = on-chain slippage floor (`min_out`, spec §11). `path` is `List<Key>` of token
  contract hashes. `to` = vault. `deadline` = U64 (ms/era — verify in manual test).
- **Path note:** no direct sCSPR↔WUSDT depth; only common pool intermediary is **WETH**
  (sCSPR↔WETH `59c4…`, WUSDT↔WETH `bb75…`). WUSDT↔WCSPR `544f23c9…` is the deepest WUSDT pool, so
  `[sCSPR, WETH, WUSDT]` or a WCSPR-bridged path; let `get_amounts_out` pick the better quote.

## sCSPR / Wise Lending staking — Mode A (caveat: stake purse)

```
stake() -> Unit                       # PAYABLE, no amount arg → CSPR via purse / loose-token pool
unstake(scspr_amount:U256) -> Unit    # burns sCSPR, queues ~16h (7-era) unbond
claim() -> Unit                       # claim CSPR after unbond delay
get_unstake_ids(account:Key) -> List<U32>;  get_unstake(unstake_id:U32) -> Any;  get_claim_time() -> U64
staked_cspr() -> U512;  get_total_stake() -> U512;  total_supply() -> U256   # exchange-rate inputs
balance_of / transfer / transfer_from / approve / allowance / decimals  # also a CEP-18 (sCSPR token)
is_paused() -> Bool;  add_loose_tokens();  restake_loose_tokens();  add_validator/remove_validator
```
- **sCSPR→CSPR exchange rate is COMPUTED** = `staked_cspr()` / `total_supply()` (no getter). Provenance: COMPUTED.
- **OPEN:** `stake()` payable semantics — CSPR arrives via a purse / the contract's loose pool, not a
  param. Verify the Odra cross-contract purse handoff in a manual stake; if awkward, use **Mode B**
  for the stake (grow) leg only. De-risk swap stays Mode A regardless. (Fast path = DEX swap anyway;
  unstake is for deliberate full exits — 16h delay.)

## Styks PriceFeed — on-chain read (D-002)

```
get_twap_price(id:String) -> Option<U64>          # PUBLIC, contract-readable → call get_twap_price("CSPRUSD")
get_last_heartbeat() -> Option<U64>               # staleness guard (spec §8)
get_current_twap_store(id:String) -> List<Option<U64>>;  get_config() -> Any
```
- **OPEN:** confirm the U64 fixed-point scale/decimals of the price in a live read so USD caps scale right.

## WUSDT (Wrapped Tether) — CEP-18 (stable refuge)

```
approve(spender:Key, amount:U256);  transfer / transfer_from;  balance_of(address:Key) -> U256
allowance / increase_allowance / decrease_allowance;  decimals() -> U8;  total_supply() -> U256
mint(owner:Key, amount:U256);  burn(owner:Key, amount:U256)   # mint present (enable_mint_burn) — useful for test funding
```

## Remaining manual checks (live tx) before locking D-001

1. Manual **swap** sCSPR→WUSDT via the router (approve + `swap_exact_tokens_for_tokens`); confirm path + `deadline` unit.
2. Manual **stake** (resolve the `stake()` purse handoff); confirm sCSPR minted + read exchange-rate inputs.
3. Read a live `get_twap_price("CSPRUSD")` value to fix the U64 scale.
