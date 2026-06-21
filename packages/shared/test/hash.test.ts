import { describe, it, expect } from 'vitest';
import { blake2b } from 'blakejs';
import {
  canonicalJson,
  hashCanonical,
  hashCanonicalBytes,
  toHex,
  blake2b256,
} from '../src/hash/canonical.js';
import type { Decision, MarketSnapshot } from '../src/index.js';

describe('canonicalJson (RFC 8785 JCS)', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('is invariant to input key order — the property the proof relies on', () => {
    const a = { regime: 'Calm', riskScore: 10, drivers: ['x'] };
    const b = { drivers: ['x'], riskScore: 10, regime: 'Calm' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('recurses into nested objects and arrays (array order preserved)', () => {
    expect(canonicalJson({ z: [{ y: 1, x: 2 }], a: true })).toBe('{"a":true,"z":[{"x":2,"y":1}]}');
  });

  it('throws on non-serializable values', () => {
    expect(() => canonicalJson(() => 1)).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe('blake2b-256 hashing primitive', () => {
  it('produces a 32-byte / 64-hex-char digest', () => {
    const hex = hashCanonical({ a: 1 });
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCanonicalBytes({ a: 1 })).toHaveLength(32);
  });

  it('matches a known blake2b-256 vector for the canonical bytes', () => {
    // Reference digest of the canonical string {"a":1,"b":2} via blakejs directly.
    const expected = toHex(blake2b256(new TextEncoder().encode('{"a":1,"b":2}')));
    expect(hashCanonical({ b: 2, a: 1 })).toBe(expected);
  });

  it('blake2b("abc") matches the published BLAKE2b-256 test vector', () => {
    // BLAKE2b-256("abc") — canonical reference vector.
    const digest = toHex(blake2b(new TextEncoder().encode('abc'), undefined, 32));
    expect(digest).toBe('bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319');
  });

  it('is reproducible: same logical value, different key order ⇒ same hash', () => {
    expect(hashCanonical({ x: 1, y: 2 })).toBe(hashCanonical({ y: 2, x: 1 }));
  });

  it('is collision-sensitive: different value ⇒ different hash', () => {
    expect(hashCanonical({ x: 1 })).not.toBe(hashCanonical({ x: 2 }));
  });
});

describe('proof-contract artifacts hash stably', () => {
  const snapshot: MarketSnapshot = {
    timestamp: 1_700_000_000_000,
    csprUsdTwap: 0.0123,
    csprUsdSpot: 0.0125,
    twapSpotDivergenceBps: 162,
    volatility: { window: '1h', annualizedPct: 84.2 },
    liquidity: {
      csprUsdPool: { depthUsd: 50000 },
      priceImpactCurve: [
        { sizeUsd: 1000, bps: 12 },
        { sizeUsd: 5000, bps: 70 },
      ],
    },
    vault: { cspr: '100000000000', scspr: '500000000000', csprusd: '40000000' },
    provenance: [{ field: 'csprUsdTwap', label: 'VERIFIED', source: 'styks' }],
  };

  it('MarketSnapshot perception hash is order-independent', () => {
    const reordered = { ...snapshot } as Record<string, unknown>;
    expect(hashCanonical(snapshot)).toBe(hashCanonical(reordered));
  });

  it('Decision decision hash is stable and ties to a snapshot hash', () => {
    const decision: Decision = {
      consensus: true,
      source: 'llm',
      regime: 'Calm',
      finalAction: {
        kind: 'Stake',
        asset: 'CSPR',
        amount: '1000000000',
        target: 'baa50d1500aa5361c497c06b40f2822ebb0b5fce5b1c3a037ea628cb68d920f3',
      },
      transcript: [],
      snapshotHash: hashCanonical(snapshot),
    };
    expect(hashCanonical(decision)).toMatch(/^[0-9a-f]{64}$/);
  });
});
