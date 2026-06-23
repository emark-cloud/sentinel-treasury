/** Receipt feed (design.md §5.6) — append-only, newest on top, one-click verify. */
'use client';
import { useState } from 'react';
import type { Cycle } from '../../lib/types';
import { HashChip, RegimePill, ResultBadge } from '../atoms';
import { deployUrl } from '../../lib/chain';
import { fmtClock } from '../../lib/format';
import { verifyCycle, type VerifyResult } from '../../lib/verify';

function ReceiptRow({ cycle, fresh }: { cycle: Cycle; fresh: boolean }) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const r = cycle.receipt;

  const runVerify = () => {
    setBusy(true);
    // Real blake2b recompute; defer a tick so the "verifying…" state paints.
    setTimeout(() => {
      setResult(verifyCycle(cycle));
      setBusy(false);
    }, 220);
  };

  return (
    <div
      className={fresh ? 'snap-in' : ''}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-ctl)',
        background: 'var(--surface-2)',
        padding: '10px 12px',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ResultBadge result={r.result} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {r.actionId}
          </span>
        </div>
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
          {fmtClock(Number(r.timestamp))}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
        <RegimePill regime={r.regime} />
        <span className="pill tone-neutral" style={{ fontSize: 10 }}>
          {r.actionKind}
        </span>
        <span className="mono" style={{ fontSize: 11, marginLeft: 'auto' }}>
          ${(Number(r.notionalUsd) / 1e6).toFixed(0)}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
        <Line k="perception" hash={r.perceptionHash} />
        <Line k="decision" hash={r.decisionHash} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-faint)' }}>deploy</span>
          <HashChip hash={r.deployHash} href={deployUrl(r.deployHash)} />
        </div>
      </div>

      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="btn"
          onClick={runVerify}
          disabled={busy}
          style={{ padding: '4px 10px', fontSize: 11 }}
        >
          {busy ? 'verifying…' : result ? '↻ re-verify' : '✓ verify ↗'}
        </button>
        {result && (
          <span
            className={result.ok ? 'pill tone-green' : 'pill tone-coral'}
            style={{ fontSize: 10 }}
          >
            {result.ok ? 'hashes match' : 'MISMATCH'}
          </span>
        )}
      </div>

      {result && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {result.checks.map((c) => (
            <div key={c.label} style={{ fontSize: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: c.ok ? 'var(--green)' : 'var(--coral)' }}>
                  {c.ok ? '✓' : '✕'}
                </span>
                <span style={{ color: 'var(--text-faint)' }}>{c.label}</span>
              </div>
              <div className="mono" style={{ color: 'var(--text-faint)', paddingLeft: 14 }}>
                {c.computed.slice(0, 24)}…
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Line({ k, hash }: { k: string; hash: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: 'var(--text-faint)' }}>{k}</span>
      <HashChip hash={hash} />
    </div>
  );
}

export function ReceiptFeed({ history, freshId }: { history: Cycle[]; freshId: string | null }) {
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <h3 className="card-title">
        Receipts · AuditLog
        <span className="label">append-only · {history.length}</span>
      </h3>
      {history.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-faint)',
            padding: '20px 0',
            textAlign: 'center',
          }}
        >
          No receipts yet. Each proven cycle appends one here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
          {history.map((c) => (
            <ReceiptRow key={c.id} cycle={c} fresh={c.id === freshId} />
          ))}
        </div>
      )}
    </section>
  );
}
