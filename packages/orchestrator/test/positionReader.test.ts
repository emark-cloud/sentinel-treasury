import { describe, it, expect } from 'vitest';
import {
  bucketUsd,
  computeNavSnapshot,
  computeUserPosition,
  buildShareLedger,
  StaticShareLedger,
  readPositions,
  normalizeAccount,
  type NavInputs,
} from '../src/data/positionReader.js';

// 1 CSPR = $0.03 → 30_000 micro-USD per CSPR. sCSPR rate = 1.05 CSPR per sCSPR.
const TWAP = 30_000n;
const RATE = { stakedCspr: 105n * 10n ** 9n, totalSupply: 100n * 10n ** 9n }; // 1.05

function navInputs(over: Partial<NavInputs> = {}): NavInputs {
  return {
    // 1000 CSPR buffer, 2000 sCSPR, 5000 WUSDT ($5000 stable).
    balances: {
      cspr: (1000n * 10n ** 9n).toString(),
      scspr: (2000n * 10n ** 9n).toString(),
      csprusd: (5000n * 10n ** 6n).toString(),
    },
    twapMicros: TWAP,
    rate: RATE,
    totalShares: 0n,
    ...over,
  };
}

describe('NAV valuation (mirrors on-chain bucket_usd)', () => {
  it('values the three buckets in micro-USD', () => {
    const b = bucketUsd(navInputs());
    // CSPR: 1000 * $0.03 = $30 → 30_000_000 micro-USD
    expect(b.cspr).toBe(30_000_000n);
    // sCSPR: 2000 sCSPR * 1.05 = 2100 CSPR * $0.03 = $63 → 63_000_000
    expect(b.scspr).toBe(63_000_000n);
    // stable: $5000 → 5_000_000_000 micro-USD (already 6-decimal)
    expect(b.csprusd).toBe(5_000_000_000n);
  });

  it('sums NAV and pegs the share index to 1.000000 at genesis', () => {
    // First deposit mints shares 1:1 with micro-USD, so totalShares == totalNavUsd at genesis.
    const totalNav = 30_000_000n + 63_000_000n + 5_000_000_000n;
    const nav = computeNavSnapshot(navInputs({ totalShares: totalNav }));
    expect(nav.totalNavUsd).toBe(totalNav.toString());
    expect(nav.navPerShareMicros).toBe('1000000'); // 1.000000
  });

  it('share index rises when NAV outgrows supply (yield)', () => {
    const totalNav = 30_000_000n + 63_000_000n + 5_000_000_000n;
    // Supply minted against half the current NAV → index ≈ 2.0.
    const nav = computeNavSnapshot(navInputs({ totalShares: totalNav / 2n }));
    expect(nav.navPerShareMicros).toBe('2000000');
  });
});

describe('user position', () => {
  it('computes value, pct of pool, and the in-kind redeem slice', () => {
    const totalNav = 30_000_000n + 63_000_000n + 5_000_000_000n;
    const nav = computeNavSnapshot(navInputs({ totalShares: totalNav }));
    // Account holds 25% of the pool.
    const pos = computeUserPosition('AccountHash', totalNav / 4n, nav);
    expect(pos.pctOfPoolBps).toBe(2500);
    expect(pos.valueUsd).toBe((totalNav / 4n).toString());
    // In-kind slice is 25% of every bucket.
    expect(pos.assetBreakdown.cspr).toBe((250n * 10n ** 9n).toString());
    expect(pos.assetBreakdown.scspr).toBe((500n * 10n ** 9n).toString());
    expect(pos.assetBreakdown.csprusd).toBe((1250n * 10n ** 6n).toString());
  });

  it('returns a zeroed position for a non-holder', () => {
    const nav = computeNavSnapshot(navInputs({ totalShares: 1000n }));
    const pos = computeUserPosition('nobody', 0n, nav);
    expect(pos.valueUsd).toBe('0');
    expect(pos.pctOfPoolBps).toBe(0);
  });
});

describe('share ledger reconstruction from events', () => {
  it('sums deposits minus redeems per account', async () => {
    const ledger = await buildShareLedger({
      deposits: async () => [
        { depositor: 'ALICE', token: null, amount: '0', sharesMinted: '100' },
        { depositor: 'bob', token: null, amount: '0', sharesMinted: '40' },
        { depositor: 'alice', token: null, amount: '0', sharesMinted: '60' },
      ],
      redeems: async () => [
        { redeemer: 'Alice', sharesBurned: '25', csprOut: '0', scsprOut: '0', csprusdOut: '0' },
      ],
    });
    expect(ledger.totalShares()).toBe(175n); // 200 minted - 25 burned
    expect(ledger.sharesOf('alice')).toBe(135n); // 160 - 25, case-insensitive
    expect(ledger.sharesOf('BOB')).toBe(40n);
    expect(ledger.sharesOf('carol')).toBe(0n);
  });

  it('normalizes 0x-prefixed and mixed-case account keys', () => {
    expect(normalizeAccount('0xABcd')).toBe('abcd');
    const s = new StaticShareLedger(10n, { abcd: 7n });
    expect(s.sharesOf('0xABCD')).toBe(7n);
  });
});

describe('readPositions end-to-end', () => {
  it('joins NAV + ledger into a snapshot and an account position', () => {
    const totalNav = 30_000_000n + 63_000_000n + 5_000_000_000n;
    const ledger = new StaticShareLedger(totalNav, { holder: totalNav / 2n });
    const { nav, position } = readPositions(
      { balances: navInputs().balances, twapMicros: TWAP, rate: RATE },
      ledger,
      'holder',
    );
    expect(nav.totalShares).toBe(totalNav.toString());
    expect(position?.pctOfPoolBps).toBe(5000);
  });
});
