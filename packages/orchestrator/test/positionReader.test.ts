import { describe, it, expect } from 'vitest';
import {
  bucketUsd,
  computeNavSnapshot,
  computeUserPosition,
  allocationBps,
  totalUsd,
  normalizeAccount,
  type NavInputs,
} from '../src/data/positionReader.js';
import type { VaultBalances } from '@sentinel/shared';

// 1 CSPR = $0.03 → 30_000 micro-USD per CSPR. sCSPR rate = 1.05 CSPR per sCSPR.
const TWAP = 30_000n;
const RATE = { stakedCspr: 105n * 10n ** 9n, totalSupply: 100n * 10n ** 9n }; // 1.05

// 1000 CSPR buffer, 2000 sCSPR, 5000 WUSDT ($5000 stable).
const BALANCES: VaultBalances = {
  cspr: (1000n * 10n ** 9n).toString(),
  scspr: (2000n * 10n ** 9n).toString(),
  csprusd: (5000n * 10n ** 6n).toString(),
};

function navInputs(over: Partial<NavInputs> = {}): NavInputs {
  return { balances: BALANCES, twapMicros: TWAP, rate: RATE, ...over };
}

describe('valuation (mirrors on-chain bucket_usd)', () => {
  it('values the three buckets in micro-USD', () => {
    const b = bucketUsd(navInputs());
    expect(b.cspr).toBe(30_000_000n); // 1000 * $0.03 = $30
    expect(b.scspr).toBe(63_000_000n); // 2000 * 1.05 = 2100 CSPR * $0.03 = $63
    expect(b.csprusd).toBe(5_000_000_000n); // $5000 (already 6-decimal)
  });

  it('totalUsd + aggregate NAV snapshot sum the buckets', () => {
    const total = 30_000_000n + 63_000_000n + 5_000_000_000n;
    expect(totalUsd(navInputs())).toBe(total);
    const nav = computeNavSnapshot(navInputs());
    expect(nav.totalNavUsd).toBe(total.toString());
    expect(nav.balances).toEqual(BALANCES);
  });

  it('allocationBps sums to 10000', () => {
    const a = allocationBps(navInputs());
    expect(a.scspr + a.csprusd + a.cspr).toBe(10_000);
    expect(a.scspr).toBe(123); // ~$63 of ~$5093
    expect(a.csprusd).toBe(9817); // ~$5000 of ~$5093
  });
});

describe('user position (per-account ledger slice)', () => {
  it('values the account from its own balances + computes its allocation', () => {
    const pos = computeUserPosition('AccountHash', BALANCES, { twapMicros: TWAP, rate: RATE });
    expect(pos.account).toBe('AccountHash');
    expect(pos.valueUsd).toBe((30_000_000n + 63_000_000n + 5_000_000_000n).toString());
    expect(pos.balances).toEqual(BALANCES);
    expect(pos.allocBps.scspr + pos.allocBps.csprusd + pos.allocBps.cspr).toBe(10_000);
  });

  it('returns a zeroed position for an empty account', () => {
    const empty: VaultBalances = { cspr: '0', scspr: '0', csprusd: '0' };
    const pos = computeUserPosition('nobody', empty, { twapMicros: TWAP, rate: RATE });
    expect(pos.valueUsd).toBe('0');
    expect(pos.allocBps).toEqual({ scspr: 0, csprusd: 0, cspr: 0 });
  });
});

describe('account key normalization', () => {
  it('normalizes 0x-prefixed and mixed-case account keys', () => {
    expect(normalizeAccount('0xABcd')).toBe('abcd');
    expect(normalizeAccount('  ABCD ')).toBe('abcd');
  });
});
