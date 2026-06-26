/**
 * Serialize a `RebalanceAction` (+ proof metadata) into the on-chain `RebalanceParams` argument
 * for `SentinelVault::execute_rebalance` (spec §4.1.3, §8.1).
 *
 * The vault's entry point takes a single named arg `params: RebalanceParams`. We encode the Odra
 * struct's exact `bytesrepr` (see `clbytes.ts`) and wrap it in `CLValue.newCLAny(...)`; Odra reads
 * the arg as raw value bytes, so this round-trips into `RebalanceParams::from_bytes` on-chain.
 *
 * **No free-form value reaches the chain unchecked** (spec §11): every field here is re-validated
 * on-chain against policy (caps via the Styks USD read, whitelist, slippage `min_out`, allocation
 * bounds) before any asset moves. The off-chain `amount`/`minOut` are merely *proposed*.
 */
import type { ActionKind, Regime, RebalanceAction, AgentAsset } from '@sentinel/shared';
import { CLValue } from '../casper/sdk.js';
import { ByteWriter } from './clbytes.js';

/** Rust `enum ActionKind` declaration order → wire u8 (odra-macros unit-enum index). */
const ACTION_KIND_INDEX: Record<ActionKind, number> = {
  Stake: 0,
  Unstake: 1,
  SwapToStable: 2,
  SwapToRisk: 3,
  NoOp: 4,
};

/** Rust `enum Asset { Cspr, Scspr, Csprusd }` ← off-chain `AgentAsset`. */
const ASSET_INDEX: Record<AgentAsset, number> = {
  CSPR: 0,
  sCSPR: 1,
  csprUSD: 2,
};

/** Rust `enum Regime` declaration order → wire u8. */
const REGIME_INDEX: Record<Regime, number> = {
  Calm: 0,
  Elevated: 1,
  Stressed: 2,
};

/** Everything `RebalanceParams` needs beyond the agent's `RebalanceAction`. */
export interface RebalanceParamsInput {
  action: RebalanceAction;
  regime: Regime;
  /** Hex blake2b-256 of the canonical `MarketSnapshot`, no `0x` prefix. */
  perceptionHash: string;
  /** Hex blake2b-256 of the canonical `Decision`, no `0x` prefix. */
  decisionHash: string;
  /**
   * Swap route as token-package-hash hex strings (`path[0]` == input token). Empty for
   * non-swap kinds. Derived by the execution layer from the configured routes, not the LLM.
   */
  path: readonly string[];
}

/** Encode `RebalanceParams` to its raw Odra `bytesrepr`. */
export function encodeRebalanceParams(input: RebalanceParamsInput): Uint8Array {
  const { action, regime, perceptionHash, decisionHash, path } = input;
  const amount = BigInt(action.amount);
  const minOut = action.minOut !== undefined ? BigInt(action.minOut) : 0n;

  return new ByteWriter()
    .u8(ACTION_KIND_INDEX[action.kind])
    .u8(ASSET_INDEX[action.asset])
    .uint(amount)
    .contractAddress(action.target)
    .uint(minOut)
    .vec(path, (w, tokenHash) => w.contractAddress(tokenHash))
    .bytes32(perceptionHash)
    .bytes32(decisionHash)
    .u8(REGIME_INDEX[regime])
    .finish();
}

/** Encode `RebalanceParams` as a `CLValue` (`Any`) ready for the runtime `Args`. */
export function rebalanceParamsCLValue(input: RebalanceParamsInput): InstanceType<typeof CLValue> {
  return CLValue.newCLAny(Buffer.from(encodeRebalanceParams(input)));
}

/**
 * Encode the depositor `account` argument for `execute_rebalance(account, params)` — an Odra
 * `Address` over a `Key::Account`. Same `CLAny`-wrapped raw-bytes convention as the params arg.
 */
export function accountAddressCLValue(accountHashHex: string): InstanceType<typeof CLValue> {
  return CLValue.newCLAny(Buffer.from(new ByteWriter().accountAddress(accountHashHex).finish()));
}
