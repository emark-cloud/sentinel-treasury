/**
 * Deposit / Withdraw flows. Each is a focused modal: enter an amount, see a live preview of what
 * happens (shares minted, or the in-kind payout), then sign → submit → finalize with the same
 * building→signing→submitted→finalized choreography the agent's ActionCard uses. Withdraw surfaces
 * the sCSPR unbonding wrinkle (in-kind redeem returns sCSPR directly — hold, unstake ~16h, or sell).
 */
'use client';
import { useState } from 'react';
import type { DepositorApi, TxPhase } from '../lib/depositor';
import type { WalletApi } from '../lib/wallet';
import { SHARE_SYMBOL, deployUrl } from '../lib/chain';
import { fmtAmount, fmtBps } from '../lib/format';

const PHASES: TxPhase[] = ['building', 'signing', 'submitted', 'finalized'];
const PHASE_LABEL: Record<TxPhase, string> = {
  idle: '',
  building: 'Building transaction',
  signing: 'Awaiting signature',
  submitted: 'Submitted to network',
  finalized: 'Finalized on-chain',
  error: 'Failed',
};

function Backdrop({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 380, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
      >
        {children}
      </div>
    </div>
  );
}

function PhaseStepper({ tx, hash }: { tx: DepositorApi['tx']; hash: string | null }) {
  if (tx.phase === 'idle') return null;
  if (tx.phase === 'error') {
    return (
      <div style={{ marginTop: 12, padding: '8px 10px', background: 'var(--coral-dim)', borderRadius: 'var(--r-ctl)' }}>
        <span className="pill tone-coral" style={{ fontSize: 11 }}>{PHASE_LABEL.error}</span>
        <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--text-dim)' }}>{tx.error}</p>
      </div>
    );
  }
  const curIdx = PHASES.indexOf(tx.phase);
  return (
    <div style={{ marginTop: 12 }}>
      {PHASES.map((p, i) => {
        const done = i < curIdx || tx.phase === 'finalized';
        const active = i === curIdx && tx.phase !== 'finalized';
        return (
          <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 12 }}>
            <span
              className={active ? 'dot pulse' : 'dot'}
              style={{ color: done ? 'var(--green)' : active ? 'var(--info)' : 'var(--text-faint)', width: 7, height: 7 }}
            />
            <span style={{ color: done ? 'var(--text)' : active ? 'var(--text)' : 'var(--text-faint)' }}>
              {PHASE_LABEL[p]}
            </span>
          </div>
        );
      })}
      {tx.phase === 'finalized' && hash && !hash.startsWith('demo-') && (
        <a className="btn" href={deployUrl(hash)} target="_blank" rel="noreferrer" style={{ marginTop: 8, display: 'inline-block' }}>
          View on cspr.live ↗
        </a>
      )}
      {tx.phase === 'finalized' && hash?.startsWith('demo-') && (
        <span className="pill tone-amber" style={{ fontSize: 10, marginTop: 8, display: 'inline-flex' }}>
          demo — no on-chain transaction
        </span>
      )}
    </div>
  );
}

export function DepositModal({
  wallet,
  depositor,
  onClose,
}: {
  wallet: WalletApi;
  depositor: DepositorApi;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState('100');
  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0;
  const preview = valid ? depositor.previewDeposit(n) : null;
  const busy = depositor.tx.phase !== 'idle' && depositor.tx.phase !== 'error' && depositor.tx.phase !== 'finalized';

  return (
    <Backdrop onClose={busy ? () => {} : onClose}>
      <h3 className="card-title">
        Deposit CSPR {!wallet.isReal && <span className="pill tone-amber" style={{ fontSize: 9, padding: '1px 6px' }}>demo</span>}
      </h3>
      <label className="label">amount (CSPR)</label>
      <input
        className="mono"
        type="number"
        min="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        disabled={busy}
        style={{
          width: '100%',
          marginTop: 4,
          padding: '8px 10px',
          background: 'var(--surface-3)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--r-ctl)',
          color: 'var(--text)',
          fontSize: 15,
        }}
      />
      {preview && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)' }}>
          You receive ≈{' '}
          <span className="mono" style={{ color: 'var(--green)' }}>
            {(Number(preview.shares) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} {SHARE_SYMBOL}
          </span>{' '}
          ({fmtBps(preview.pctOfPoolBps)} of pool)
        </div>
      )}

      <PhaseStepper tx={depositor.tx} hash={depositor.tx.deployHash} />

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn" onClick={onClose} disabled={busy} style={{ flex: 1 }}>
          {depositor.tx.phase === 'finalized' ? 'Done' : 'Cancel'}
        </button>
        <button
          className="btn"
          onClick={() => void depositor.deposit(n)}
          disabled={!valid || busy || depositor.tx.phase === 'finalized'}
          style={{ flex: 1, borderColor: 'var(--green)', color: 'var(--green)' }}
        >
          {busy ? '…' : 'Deposit'}
        </button>
      </div>
    </Backdrop>
  );
}

export function WithdrawModal({
  wallet,
  depositor,
  onClose,
}: {
  wallet: WalletApi;
  depositor: DepositorApi;
  onClose: () => void;
}) {
  const [pct, setPct] = useState(50);
  const heldShares = BigInt(depositor.position?.shares ?? '0');
  const redeemShares = ((heldShares * BigInt(Math.round(pct))) / 100n).toString();
  const payout = depositor.previewRedeem(redeemShares);
  const busy = depositor.tx.phase !== 'idle' && depositor.tx.phase !== 'error' && depositor.tx.phase !== 'finalized';

  return (
    <Backdrop onClose={busy ? () => {} : onClose}>
      <h3 className="card-title">
        Withdraw {!wallet.isReal && <span className="pill tone-amber" style={{ fontSize: 9, padding: '1px 6px' }}>demo</span>}
      </h3>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="label">redeem</span>
        <span className="mono" style={{ fontSize: 14, color: 'var(--text)' }}>{pct}%</span>
      </div>
      <input
        type="range"
        min="1"
        max="100"
        value={pct}
        onChange={(e) => setPct(Number(e.target.value))}
        disabled={busy}
        style={{ width: '100%', marginTop: 4, accentColor: 'var(--info)' }}
      />

      <div style={{ marginTop: 10 }}>
        <span className="label">you receive in-kind</span>
        <div style={{ marginTop: 4, fontSize: 12 }}>
          <Line label="sCSPR" value={fmtAmount(payout.scspr, 'sCSPR')} note="16h to unstake → CSPR, or sell instantly on the DEX" />
          <Line label="csprUSD" value={fmtAmount(payout.csprusd, 'csprUSD')} />
          <Line label="CSPR" value={fmtAmount(payout.cspr, 'CSPR')} />
        </div>
      </div>

      <PhaseStepper tx={depositor.tx} hash={depositor.tx.deployHash} />

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn" onClick={onClose} disabled={busy} style={{ flex: 1 }}>
          {depositor.tx.phase === 'finalized' ? 'Done' : 'Cancel'}
        </button>
        <button
          className="btn"
          onClick={() => void depositor.redeem(redeemShares)}
          disabled={busy || heldShares === 0n || depositor.tx.phase === 'finalized'}
          style={{ flex: 1, borderColor: 'var(--coral)', color: 'var(--coral)' }}
        >
          {busy ? '…' : 'Withdraw'}
        </button>
      </div>
    </Backdrop>
  );
}

function Line({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ padding: '2px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: 'var(--text-dim)' }}>{label}</span>
        <span className="mono" style={{ color: 'var(--text)' }}>{value}</span>
      </div>
      {note && <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{note}</div>}
    </div>
  );
}
