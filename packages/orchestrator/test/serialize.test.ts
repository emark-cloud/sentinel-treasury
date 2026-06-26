import { describe, it, expect } from 'vitest';
import type { RebalanceAction, Receipt } from '@sentinel/shared';
import { ByteReader, ByteWriter, stripBlobPrefix } from '../src/execution/clbytes.js';
import { encodeRebalanceParams } from '../src/execution/serialize.js';
import { encodeReceipt, parseReceipt } from '../src/proof/receiptCodec.js';

const h32 = (b: string) => b.repeat(32);

describe('clbytes primitives', () => {
  it('round-trips casper U256 (length-prefixed minimal LE)', () => {
    for (const v of [0n, 1n, 255n, 256n, 1_000_000_000n, 2n ** 200n + 7n]) {
      const bytes = new ByteWriter().uint(v).finish();
      expect(new ByteReader(bytes).uint()).toBe(v);
    }
    // zero encodes as a single length byte 0.
    expect(Array.from(new ByteWriter().uint(0n).finish())).toEqual([0]);
    // 1e9 = 0x3B9ACA00 → 4 LE bytes prefixed by length 4.
    expect(Array.from(new ByteWriter().uint(1_000_000_000n).finish())).toEqual([
      4, 0x00, 0xca, 0x9a, 0x3b,
    ]);
  });

  it('encodes u32/u64 little-endian and fixed 32-byte arrays', () => {
    expect(Array.from(new ByteWriter().u32(2).finish())).toEqual([2, 0, 0, 0]);
    expect(new ByteReader(new ByteWriter().u64(123456789n).finish()).u64()).toBe(123456789n);
    expect(new ByteWriter().bytes32(h32('ab')).finish()).toHaveLength(32);
  });

  it('encodes Address as a Key (Account tag 0 / Hash tag 1)', () => {
    expect(new ByteWriter().contractAddress(h32('11')).finish()[0]).toBe(1);
    expect(new ByteWriter().accountAddress(h32('22')).finish()[0]).toBe(0);
  });

  it('stripBlobPrefix removes a List<U8> length prefix when present', () => {
    const inner = Uint8Array.from([9, 9, 9]);
    const blob = new ByteWriter().u32(inner.length).raw(inner).finish();
    expect(Array.from(stripBlobPrefix(blob))).toEqual([9, 9, 9]);
    // No prefix → unchanged.
    expect(Array.from(stripBlobPrefix(inner))).toEqual([9, 9, 9]);
  });
});

describe('encodeRebalanceParams', () => {
  const action: RebalanceAction = {
    kind: 'SwapToStable',
    asset: 'sCSPR',
    amount: '1000000000',
    target: h32('11'),
    minOut: '500',
  };

  it('pins enum wire indices and decodes back to the input fields', () => {
    const bytes = encodeRebalanceParams({
      action,
      regime: 'Stressed',
      perceptionHash: h32('ab'),
      decisionHash: h32('cd'),
      path: [h32('aa'), h32('bb')],
    });
    const r = new ByteReader(bytes);
    expect(r.u8()).toBe(2); // ActionKind::SwapToStable
    expect(r.u8()).toBe(1); // Asset::Scspr
    expect(r.uint()).toBe(1_000_000_000n); // amount
    const target = r.address();
    expect(target.tag).toBe(1); // Key::Hash (contract)
    expect(target.hex).toBe(h32('11'));
    expect(r.uint()).toBe(500n); // min_out
    const path = r.vec((rr) => rr.address());
    expect(path.map((a) => a.hex)).toEqual([h32('aa'), h32('bb')]);
    expect(path.every((a) => a.tag === 1)).toBe(true);
    expect(r.bytes32Hex()).toBe(h32('ab')); // perception_hash
    expect(r.bytes32Hex()).toBe(h32('cd')); // decision_hash
    expect(r.u8()).toBe(2); // Regime::Stressed
    expect(r.remaining).toBe(0);
  });

  it('defaults min_out to 0 when the action carries none', () => {
    const noMin: RebalanceAction = { kind: 'Stake', asset: 'CSPR', amount: '7', target: h32('33') };
    const bytes = encodeRebalanceParams({
      action: noMin,
      regime: 'Calm',
      perceptionHash: h32('00'),
      decisionHash: h32('00'),
      path: [],
    });
    const r = new ByteReader(bytes);
    expect(r.u8()).toBe(0); // Stake
    expect(r.u8()).toBe(0); // Cspr
    expect(r.uint()).toBe(7n);
    expect(r.address().hex).toBe(h32('33'));
    expect(r.uint()).toBe(0n); // min_out defaulted
    expect(r.vec((rr) => rr.address())).toHaveLength(0);
  });
});

describe('Receipt codec round-trip', () => {
  it('encodes then parses back to an equal Receipt', () => {
    const receipt: Receipt = {
      actionId: '42',
      timestamp: '1718000000000',
      agent: h32('a1'),
      account: h32('ac'),
      actionKind: 'SwapToStable',
      regime: 'Stressed',
      perceptionHash: h32('ab'),
      decisionHash: h32('cd'),
      preAllocBps: { scspr: 6000, csprusd: 4000, cspr: 0 },
      postAllocBps: { scspr: 2000, csprusd: 8000, cspr: 0 },
      amount: '1000000000',
      notionalUsd: '3070000',
      target: h32('11'),
      deployHash: h32('00'),
      result: 'Success',
      csprUsdTwap: '307',
    };
    const parsed = parseReceipt(encodeReceipt(receipt));
    expect(parsed).toEqual(receipt);
  });
});
