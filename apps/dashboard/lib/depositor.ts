/**
 * Depositor state — "get my funds in, see my balance and where it's allocated."
 *
 * Backed by the same share math the contract uses (`@sentinel/shared` `position.ts`), so the demo
 * mirrors on-chain behaviour exactly: deposits mint shares pro-rata to NAV, redeems burn shares and
 * pay out the depositor's in-kind slice of every bucket.
 *
 * Two modes behind one hook (mirrors the loop's ScenarioSource seam, spec §15.3):
 *  - **live** (real wallet + configured backend): balances/shares are read from `/api/*`
 *    (CSPR.cloud + the vault event stream) and deposit/redeem submit a real `TransactionV1`.
 *  - **demo** (default / no extension): an in-memory vault so the full onboarding flow is
 *    exercisable on stage. Demo state is clearly tagged in the UI.
 */
'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bucketUsd,
  computeNavSnapshot,
  computeUserPosition,
  sharesForDeposit,
  type NavSnapshot,
  type UserPosition,
  type VaultBalances,
} from '@sentinel/shared';
import type { WalletApi } from './wallet';
import { fetchVault, fetchPosition, type VaultApiResponse } from './casper/reads';
import { submitDeposit, submitRedeem } from './casper/tx';

const CSPR = 1_000_000_000n; // motes per CSPR
const USD = 1_000_000n; // micro-USD per $1

/** Demo price/rate — labelled, not a live Styks read (real mode reads the chain). */
const DEMO_TWAP_MICROS = 30_700n; // $0.0307 / CSPR
const DEMO_RATE = { stakedCspr: 1052n, totalSupply: 1000n }; // 1.052 CSPR per sCSPR

export type TxPhase = 'idle' | 'building' | 'signing' | 'submitted' | 'finalized' | 'error';
export interface TxState {
  phase: TxPhase;
  deployHash: string | null;
  error: string | null;
}

export interface InKindPayout {
  cspr: string;
  scspr: string;
  csprusd: string;
}

export interface DepositorApi {
  live: boolean;
  vault: NavSnapshot;
  position: UserPosition | null;
  tx: TxState;
  /** Preview shares minted + % of pool for a prospective CSPR deposit (no state change). */
  previewDeposit: (amountCspr: number) => { shares: string; pctOfPoolBps: number };
  /** Preview the in-kind payout for redeeming `shares`. */
  previewRedeem: (shares: string) => InKindPayout;
  deposit: (amountCspr: number) => Promise<void>;
  redeem: (shares: string) => Promise<void>;
  refresh: () => void;
  /** Clear the tx stepper back to idle (called when (re)opening a flow). */
  resetTx: () => void;
}

// ----------------------------------------------------------------- in-memory demo vault

class DemoVault {
  balances: { cspr: bigint; scspr: bigint; csprusd: bigint };
  supply: bigint;
  shares = new Map<string, bigint>();

  constructor() {
    // Seed a healthy calm book: ~$6k sCSPR / ~$4k stable / 75 CSPR buffer, all owned by a
    // synthetic genesis treasury so a freshly-connected user starts at 0% and grows by depositing.
    this.balances = {
      scspr: 185_773n * CSPR, // ≈ $6,000 at the demo rate/price
      csprusd: 4_000n * USD, // $4,000 stable
      cspr: 75n * CSPR, // working buffer
    };
    const navMicros = this.navUsd();
    this.supply = navMicros; // genesis: 1 share per micro-USD ⇒ NAV/share = 1.000000
    this.shares.set('genesis-treasury', navMicros);
  }

  private balStrings(): VaultBalances {
    return {
      cspr: this.balances.cspr.toString(),
      scspr: this.balances.scspr.toString(),
      csprusd: this.balances.csprusd.toString(),
    };
  }

  private navUsd(): bigint {
    const b = bucketUsd({
      balances: this.balStrings(),
      twapMicros: DEMO_TWAP_MICROS,
      rate: DEMO_RATE,
      totalShares: 0n,
    });
    return b.scspr + b.csprusd + b.cspr;
  }

  snapshot(): NavSnapshot {
    return computeNavSnapshot({
      balances: this.balStrings(),
      twapMicros: DEMO_TWAP_MICROS,
      rate: DEMO_RATE,
      totalShares: this.supply,
    });
  }

  position(account: string): UserPosition {
    return computeUserPosition(account, this.shares.get(account) ?? 0n, this.snapshot());
  }

  sharesForCspr(amountCspr: number): bigint {
    const motes = BigInt(Math.round(amountCspr * 1e9));
    const depositUsd = (motes * DEMO_TWAP_MICROS) / CSPR;
    return sharesForDeposit(depositUsd, this.navUsd(), this.supply);
  }

  deposit(account: string, amountCspr: number): void {
    const motes = BigInt(Math.round(amountCspr * 1e9));
    const minted = this.sharesForCspr(amountCspr);
    this.balances.cspr += motes;
    this.supply += minted;
    this.shares.set(account, (this.shares.get(account) ?? 0n) + minted);
  }

  payoutFor(shares: bigint): InKindPayout {
    if (this.supply === 0n) return { cspr: '0', scspr: '0', csprusd: '0' };
    return {
      cspr: ((this.balances.cspr * shares) / this.supply).toString(),
      scspr: ((this.balances.scspr * shares) / this.supply).toString(),
      csprusd: ((this.balances.csprusd * shares) / this.supply).toString(),
    };
  }

  redeem(account: string, shares: bigint): void {
    const held = this.shares.get(account) ?? 0n;
    const burn = shares > held ? held : shares;
    if (burn === 0n || this.supply === 0n) return;
    const out = this.payoutFor(burn);
    this.balances.cspr -= BigInt(out.cspr);
    this.balances.scspr -= BigInt(out.scspr);
    this.balances.csprusd -= BigInt(out.csprusd);
    this.supply -= burn;
    this.shares.set(account, held - burn);
  }
}

// ----------------------------------------------------------------- hook

export function useDepositor(wallet: WalletApi): DepositorApi {
  const demo = useRef<DemoVault | undefined>(undefined);
  if (!demo.current) demo.current = new DemoVault();

  const [vault, setVault] = useState<NavSnapshot>(() => demo.current!.snapshot());
  const [position, setPosition] = useState<UserPosition | null>(null);
  const [live, setLive] = useState(false);
  const [tx, setTx] = useState<TxState>({ phase: 'idle', deployHash: null, error: null });
  const account = wallet.activeKey;
  const useLive = wallet.isReal; // real extension ⇒ attempt the live backend + on-chain tx

  const refresh = useCallback(() => {
    if (useLive && account) {
      // Live: read whole-vault NAV + this account's position from the backend.
      void Promise.all([fetchVault(), fetchPosition(account)])
        .then(([v, p]: [VaultApiResponse, { live: boolean; position: UserPosition | null }]) => {
          setLive(v.live);
          setVault(v.nav);
          setPosition(p.position);
        })
        .catch(() => {
          setLive(false);
          setVault(demo.current!.snapshot());
          setPosition(account ? demo.current!.position(account) : null);
        });
      return;
    }
    setLive(false);
    setVault(demo.current!.snapshot());
    setPosition(account ? demo.current!.position(account) : null);
  }, [useLive, account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const previewDeposit = useCallback(
    (amountCspr: number) => {
      const shares = demo.current!.sharesForCspr(amountCspr);
      const supply = BigInt(vault.totalShares) + shares;
      const pct = supply === 0n ? 0 : Number((shares * 10_000n) / supply);
      return { shares: shares.toString(), pctOfPoolBps: pct };
    },
    [vault.totalShares],
  );

  const previewRedeem = useCallback((shares: string) => {
    return demo.current!.payoutFor(BigInt(shares || '0'));
  }, []);

  const deposit = useCallback(
    async (amountCspr: number) => {
      if (!account) return;
      if (useLive && wallet.provider) {
        setTx({ phase: 'building', deployHash: null, error: null });
        try {
          const hash = await submitDeposit(wallet.provider, account, amountCspr, (phase) =>
            setTx((t) => ({ ...t, phase })),
          );
          setTx({ phase: 'finalized', deployHash: hash, error: null });
          refresh();
        } catch (e) {
          setTx({ phase: 'error', deployHash: null, error: e instanceof Error ? e.message : 'Deposit failed' });
        }
        return;
      }
      // Demo: choreograph the same phases, then mutate the in-memory vault.
      setTx({ phase: 'signing', deployHash: null, error: null });
      demo.current!.deposit(account, amountCspr);
      setTx({ phase: 'finalized', deployHash: 'demo-' + Date.now().toString(16), error: null });
      refresh();
    },
    [account, useLive, wallet.provider, refresh],
  );

  const redeem = useCallback(
    async (shares: string) => {
      if (!account) return;
      if (useLive && wallet.provider) {
        setTx({ phase: 'building', deployHash: null, error: null });
        try {
          const hash = await submitRedeem(wallet.provider, account, shares, (phase) =>
            setTx((t) => ({ ...t, phase })),
          );
          setTx({ phase: 'finalized', deployHash: hash, error: null });
          refresh();
        } catch (e) {
          setTx({ phase: 'error', deployHash: null, error: e instanceof Error ? e.message : 'Withdraw failed' });
        }
        return;
      }
      setTx({ phase: 'signing', deployHash: null, error: null });
      demo.current!.redeem(account, BigInt(shares || '0'));
      setTx({ phase: 'finalized', deployHash: 'demo-' + Date.now().toString(16), error: null });
      refresh();
    },
    [account, useLive, wallet.provider, refresh],
  );

  const resetTx = useCallback(() => setTx({ phase: 'idle', deployHash: null, error: null }), []);

  // Reset the position when the wallet disconnects.
  useEffect(() => {
    if (!wallet.connected) {
      setPosition(null);
      setTx({ phase: 'idle', deployHash: null, error: null });
    }
  }, [wallet.connected]);

  return useMemo<DepositorApi>(
    () => ({
      live,
      vault,
      position,
      tx,
      previewDeposit,
      previewRedeem,
      deposit,
      redeem,
      refresh,
      resetTx,
    }),
    [live, vault, position, tx, previewDeposit, previewRedeem, deposit, redeem, refresh, resetTx, wallet.connected],
  );
}
