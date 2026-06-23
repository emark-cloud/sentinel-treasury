/**
 * `Receipt` (de)serialization (spec §4.2.1, §9) — parse the tamper-evident record the vault wrote
 * to the AuditLog back into the off-chain `Receipt` shape so the verification procedure can read
 * the on-chain `perceptionHash`/`decisionHash`. The encoder is the round-trip inverse, used by the
 * test suite as the oracle for the parser (byte-exact against the Odra `bytesrepr` field order).
 *
 * Field order mirrors `packages/contracts/src/types.rs::Receipt`. Addresses are stored as the
 * 32-byte `Key` body hex (account/contract tag dropped — the body is the account/package hash).
 */
import type { Receipt, ActionKind, Regime, ActionResult, AllocationBps } from '@sentinel/shared';
import { ByteReader, ByteWriter } from '../execution/clbytes.js';

const ACTION_KINDS: ActionKind[] = ['Stake', 'Unstake', 'SwapToStable', 'SwapToRisk', 'NoOp'];
const REGIMES: Regime[] = ['Calm', 'Elevated', 'Stressed'];
const ACTION_RESULTS: ActionResult[] = ['Success', 'Reverted', 'Skipped'];

function indexOf<T>(list: T[], value: T, label: string): number {
  const i = list.indexOf(value);
  if (i < 0) throw new Error(`unknown ${label}: ${String(value)}`);
  return i;
}

function readAlloc(r: ByteReader): AllocationBps {
  return { scspr: r.u32(), csprusd: r.u32(), cspr: r.u32() };
}

function writeAlloc(w: ByteWriter, a: AllocationBps): void {
  w.u32(a.scspr).u32(a.csprusd).u32(a.cspr);
}

/** Parse the raw `bytesrepr` of a stored `Receipt`. */
export function parseReceipt(bytes: Uint8Array): Receipt {
  const r = new ByteReader(bytes);
  const actionId = r.u64().toString();
  const timestamp = r.u64().toString();
  const agent = r.address().hex;
  const actionKind = ACTION_KINDS[r.u8()]!;
  const regime = REGIMES[r.u8()]!;
  const perceptionHash = r.bytes32Hex();
  const decisionHash = r.bytes32Hex();
  const preAllocBps = readAlloc(r);
  const postAllocBps = readAlloc(r);
  const amount = r.uint().toString();
  const notionalUsd = r.uint().toString();
  const target = r.address().hex;
  const deployHash = r.bytes32Hex();
  const result = ACTION_RESULTS[r.u8()]!;
  const csprUsdTwap = r.uint().toString();
  return {
    actionId,
    timestamp,
    agent,
    actionKind,
    regime,
    perceptionHash,
    decisionHash,
    preAllocBps,
    postAllocBps,
    amount,
    notionalUsd,
    target,
    deployHash,
    result,
    csprUsdTwap,
  };
}

/** Encode a `Receipt` to its raw `bytesrepr` (round-trip inverse of {@link parseReceipt}). */
export function encodeReceipt(
  receipt: Receipt,
  agentIsContract = false,
  targetIsContract = true,
): Uint8Array {
  const w = new ByteWriter().u64(BigInt(receipt.actionId)).u64(BigInt(receipt.timestamp));
  (agentIsContract ? w.contractAddress(receipt.agent) : w.accountAddress(receipt.agent))
    .u8(indexOf(ACTION_KINDS, receipt.actionKind, 'ActionKind'))
    .u8(indexOf(REGIMES, receipt.regime, 'Regime'))
    .bytes32(receipt.perceptionHash)
    .bytes32(receipt.decisionHash);
  writeAlloc(w, receipt.preAllocBps);
  writeAlloc(w, receipt.postAllocBps);
  w.uint(BigInt(receipt.amount)).uint(BigInt(receipt.notionalUsd));
  (targetIsContract ? w.contractAddress(receipt.target) : w.accountAddress(receipt.target))
    .bytes32(receipt.deployHash)
    .u8(indexOf(ACTION_RESULTS, receipt.result, 'ActionResult'))
    .uint(BigInt(receipt.csprUsdTwap));
  return w.finish();
}
