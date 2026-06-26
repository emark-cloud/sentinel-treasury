/**
 * Deposit / Withdraw flows. Each is a focused modal: enter an amount, see a live preview of what
 * happens (shares minted, or the in-kind payout), then sign → submit → finalize with the same
 * building→signing→submitted→finalized choreography the agent's ActionCard uses. Withdraw surfaces
 * the sCSPR unbonding wrinkle (in-kind redeem returns sCSPR directly — hold, unstake ~16h, or sell).
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import type { DepositorApi, TxPhase } from '../lib/depositor';
import type { WalletApi } from '../lib/wallet';
import { deployUrl } from '../lib/chain';
import { fmtAmount } from '../lib/format';

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
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes; focus moves into the dialog on open and returns to the
  // triggering element on close (a11y floor — keyboard users aren't stranded).
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current
      ?.querySelector<HTMLElement>('input, button, [href], [tabindex]')
      ?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, [onClose]);

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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 380, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
      >
        {children}
      </div>
    </div>
  );
}

/** Map a raw chain/wallet error to a plain-language problem + a suggested fix. */
function explainTxError(raw: string | null): { problem: string; fix: string } {
  const e = (raw ?? '').toLowerCase();
  if (/reject|cancel|denied|declined/.test(e))
    return {
      problem: 'You declined the signature in your wallet.',
      fix: 'Reopen your wallet and approve the transaction to continue.',
    };
  if (/insufficient|not enough|balance|out of gas|funds/.test(e))
    return {
      problem: "Your account can't cover the amount plus the network fee.",
      fix: 'Lower the amount or top up CSPR, then try again.',
    };
  if (/network|rpc|fetch|timeout|timed out|proxy_caller|\b(429|5\d\d)\b/.test(e))
    return {
      problem: "Couldn't reach the Testnet node.",
      fix: 'Check your connection and try again in a moment.',
    };
  return {
    problem: raw || 'The transaction failed.',
    fix: 'Try again; if it keeps failing, reset the demo and retry.',
  };
}

function PhaseStepper({ tx, hash }: { tx: DepositorApi['tx']; hash: string | null }) {
  if (tx.phase === 'idle') return null;
  if (tx.phase === 'error') {
    const { problem, fix } = explainTxError(tx.error);
    return (
      <div style={{ marginTop: 12, padding: '8px 10px', background: 'var(--coral-dim)', borderRadius: 'var(--r-ctl)' }}>
        <span className="pill tone-coral" style={{ fontSize: 11 }}>{PHASE_LABEL.error}</span>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text)' }}>{problem}</p>
        <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-dim)' }}>{fix}</p>
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
          Credited to your position ≈{' '}
          <span className="mono" style={{ color: 'var(--green)' }}>
            ${(Number(preview.valueUsdMicros) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </span>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>
            lands as your own CSPR · the agent manages it within your guardrails · withdraw anytime
          </div>
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
  const bal = depositor.position?.balances ?? { cspr: '0', scspr: '0', csprusd: '0' };
  const empty = bal.cspr === '0' && bal.scspr === '0' && bal.csprusd === '0';
  const busy = depositor.tx.phase !== 'idle' && depositor.tx.phase !== 'error' && depositor.tx.phase !== 'finalized';

  return (
    <Backdrop onClose={busy ? () => {} : onClose}>
      <h3 className="card-title">
        Withdraw {!wallet.isReal && <span className="pill tone-amber" style={{ fontSize: 9, padding: '1px 6px' }}>demo</span>}
      </h3>
      <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--text-dim)' }}>
        A full exit pays out your own in-kind slice and clears your position. These are your funds —
        no pooling, no pro-rata of anyone else.
      </p>

      <div style={{ marginTop: 6 }}>
        <span className="label">you receive in-kind</span>
        <div style={{ marginTop: 4, fontSize: 12 }}>
          <Line label="sCSPR" value={fmtAmount(bal.scspr, 'sCSPR')} note="16h to unstake → CSPR, or sell instantly on the DEX" />
          <Line label="csprUSD" value={fmtAmount(bal.csprusd, 'csprUSD')} />
          <Line label="CSPR" value={fmtAmount(bal.cspr, 'CSPR')} />
        </div>
      </div>

      <PhaseStepper tx={depositor.tx} hash={depositor.tx.deployHash} />

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn" onClick={onClose} disabled={busy} style={{ flex: 1 }}>
          {depositor.tx.phase === 'finalized' ? 'Done' : 'Cancel'}
        </button>
        <button
          className="btn"
          onClick={() => void depositor.redeem()}
          disabled={busy || empty || depositor.tx.phase === 'finalized'}
          style={{ flex: 1, borderColor: 'var(--coral)', color: 'var(--coral)' }}
        >
          {busy ? '…' : 'Withdraw all'}
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
