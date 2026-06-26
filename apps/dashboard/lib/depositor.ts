/**
 * Depositor state — "get my funds in, see my own balance and where it's allocated."
 *
 * Multi-tenant vault: each depositor owns an explicit ledger slice (their own cspr/scspr/csprusd),
 * not pooled shares. The demo mirrors the on-chain behaviour exactly — a deposit lands as *your
 * own* CSPR, a withdraw pays your own balance back in-kind, and a full redeem empties your slice.
 * Valuation reuses `@sentinel/shared` (`position.ts`) so the $ value shown equals the contract's
 * `account_value_usd`.
 *
 * Two modes behind one hook (mirrors the loop's ScenarioSource seam, spec §15.3):
 *  - **live** (real wallet + configured backend): aggregate TVL + this account's slice from `/api/*`,
 *    and deposit/withdraw/redeem submit a real `TransactionV1`.
 *  - **demo** (default / no extension): an in-memory multi-tenant vault so the full onboarding flow
 *    is exercisable on stage. Demo state is clearly tagged in the UI.
 */
'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeNavSnapshot,
  computeUserPosition,
  type NavSnapshot,
  type UserPosition,
  type VaultBalances,
} from '@sentinel/shared';
import type { WalletApi } from './wallet';
import { fetchVault, fetchPosition, type VaultApiResponse } from './casper/reads';
import { submitDeposit, submitWithdraw, submitRedeem } from './casper/tx';

const CSPR = 1_000_000_000n; // motes per CSPR
const USD = 1_000_000n; // micro-USD per $1

/** Demo price/rate — labelled, not a live Styks read (real mode reads the chain). */
const DEMO_TWAP_MICROS = 30_700n; // $0.0307 / CSPR
const DEMO_RATE = { stakedCspr: 1052n, totalSupply: 1000n }; // 1.052 CSPR per sCSPR

/** The three managed assets a withdraw can target. */
export type WithdrawAsset = 'CSPR' | 'sCSPR' | 'csprUSD';

export type TxPhase = 'idle' | 'building' | 'signing' | 'submitted' | 'finalized' | 'error';
export interface TxState {
  phase: TxPhase;
  deployHash: string | null;
  error: string | null;
}

export interface DepositorApi {
  live: boolean;
  /** Aggregate vault TVL (all accounts). */
  vault: NavSnapshot;
  /** The connected account's own ledger slice + valuation, or null when disconnected/empty. */
  position: UserPosition | null;
  tx: TxState;
  /** Preview the micro-USD value a prospective CSPR deposit credits to your position. */
  previewDeposit: (amountCspr: number) => { valueUsdMicros: string };
  deposit: (amountCspr: number) => Promise<void>;
  /** Withdraw `amountBase` (base units) of one asset from your own ledger slice. */
  withdraw: (asset: WithdrawAsset, amountBase: string) => Promise<void>;
  /** Full exit: pay out your entire in-kind slice and zero your ledger. */
  redeem: () => Promise<void>;
  refresh: () => void;
  resetTx: () => void;
}

interface Ledger {
  cspr: bigint;
  scspr: bigint;
  csprusd: bigint;
}

// ----------------------------------------------------------------- in-memory demo vault

class DemoVault {
  private ledgers = new Map<string, Ledger>();

  constructor() {
    // Seed a synthetic genesis treasury so aggregate TVL is non-trivial and a freshly-connected
    // user starts at 0 and grows by depositing into their *own* slice.
    this.ledgers.set('genesis-treasury', {
      scspr: 185_773n * CSPR, // ≈ $6,000 at the demo rate/price
      csprusd: 4_000n * USD, // $4,000 stable
      cspr: 75n * CSPR, // working buffer
    });
  }

  private ledgerOf(account: string): Ledger {
    return this.ledgers.get(account) ?? { cspr: 0n, scspr: 0n, csprusd: 0n };
  }

  private balStrings(l: Ledger): VaultBalances {
    return { cspr: l.cspr.toString(), scspr: l.scspr.toString(), csprusd: l.csprusd.toString() };
  }

  /** Column sums across every account's ledger == the vault's holdings (the sum invariant). */
  private aggregate(): VaultBalances {
    let cspr = 0n;
    let scspr = 0n;
    let csprusd = 0n;
    for (const l of this.ledgers.values()) {
      cspr += l.cspr;
      scspr += l.scspr;
      csprusd += l.csprusd;
    }
    return { cspr: cspr.toString(), scspr: scspr.toString(), csprusd: csprusd.toString() };
  }

  snapshot(): NavSnapshot {
    return computeNavSnapshot({ balances: this.aggregate(), twapMicros: DEMO_TWAP_MICROS, rate: DEMO_RATE });
  }

  position(account: string): UserPosition {
    return computeUserPosition(account, this.balStrings(this.ledgerOf(account)), {
      twapMicros: DEMO_TWAP_MICROS,
      rate: DEMO_RATE,
    });
  }

  valueUsdForCspr(amountCspr: number): bigint {
    const motes = BigInt(Math.round(amountCspr * 1e9));
    return (motes * DEMO_TWAP_MICROS) / CSPR;
  }

  deposit(account: string, amountCspr: number): void {
    const l = { ...this.ledgerOf(account) };
    l.cspr += BigInt(Math.round(amountCspr * 1e9));
    this.ledgers.set(account, l);
  }

  withdraw(account: string, asset: WithdrawAsset, amountBase: string): void {
    const l = { ...this.ledgerOf(account) };
    const amt = BigInt(amountBase || '0');
    if (asset === 'CSPR') l.cspr = l.cspr > amt ? l.cspr - amt : 0n;
    else if (asset === 'sCSPR') l.scspr = l.scspr > amt ? l.scspr - amt : 0n;
    else l.csprusd = l.csprusd > amt ? l.csprusd - amt : 0n;
    this.ledgers.set(account, l);
  }

  redeem(account: string): void {
    this.ledgers.set(account, { cspr: 0n, scspr: 0n, csprusd: 0n });
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

  const previewDeposit = useCallback((amountCspr: number) => {
    return { valueUsdMicros: demo.current!.valueUsdForCspr(amountCspr).toString() };
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
      setTx({ phase: 'signing', deployHash: null, error: null });
      demo.current!.deposit(account, amountCspr);
      setTx({ phase: 'finalized', deployHash: 'demo-' + Date.now().toString(16), error: null });
      refresh();
    },
    [account, useLive, wallet.provider, refresh],
  );

  const withdraw = useCallback(
    async (asset: WithdrawAsset, amountBase: string) => {
      if (!account) return;
      if (useLive && wallet.provider) {
        setTx({ phase: 'building', deployHash: null, error: null });
        try {
          const hash = await submitWithdraw(wallet.provider, account, asset, amountBase, (phase) =>
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
      demo.current!.withdraw(account, asset, amountBase);
      setTx({ phase: 'finalized', deployHash: 'demo-' + Date.now().toString(16), error: null });
      refresh();
    },
    [account, useLive, wallet.provider, refresh],
  );

  const redeem = useCallback(async () => {
    if (!account) return;
    if (useLive && wallet.provider) {
      setTx({ phase: 'building', deployHash: null, error: null });
      try {
        const hash = await submitRedeem(wallet.provider, account, (phase) => setTx((t) => ({ ...t, phase })));
        setTx({ phase: 'finalized', deployHash: hash, error: null });
        refresh();
      } catch (e) {
        setTx({ phase: 'error', deployHash: null, error: e instanceof Error ? e.message : 'Withdraw failed' });
      }
      return;
    }
    setTx({ phase: 'signing', deployHash: null, error: null });
    demo.current!.redeem(account);
    setTx({ phase: 'finalized', deployHash: 'demo-' + Date.now().toString(16), error: null });
    refresh();
  }, [account, useLive, wallet.provider, refresh]);

  const resetTx = useCallback(() => setTx({ phase: 'idle', deployHash: null, error: null }), []);

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
      deposit,
      withdraw,
      redeem,
      refresh,
      resetTx,
    }),
    [live, vault, position, tx, previewDeposit, deposit, withdraw, redeem, refresh, resetTx],
  );
}
