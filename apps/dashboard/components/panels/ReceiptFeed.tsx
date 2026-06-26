/** Receipt feed (design.md §5.6) — append-only, newest on top, every entry self-verifies. */
'use client';
import { useEffect, useState } from 'react';
import type { Cycle } from '../../lib/types';
import { ActionChip, HashChip, ResultBadge } from '../atoms';
import { deployUrl } from '../../lib/chain';
import { fmtAgo, fmtBps, fmtPrice, fmtUsd } from '../../lib/format';
import { verifyCycle, type VerifyResult } from '../../lib/verify';

function MetaRow({
  left,
  right,
  dim,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 11,
        color: dim ? 'var(--text-faint)' : 'var(--text-dim)',
      }}
    >
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}

function ReceiptRow({ cycle, fresh }: { cycle: Cycle; fresh: boolean }) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [open, setOpen] = useState(false);
  const r = cycle.receipt;
  const skipped = r.result === 'Skipped';
  const twap = Number(r.csprUsdTwap) / 1e5;
  const num = r.actionId.replace(/^\D+/, '');

  // Self-verify on mount — a real blake2b recompute over the canonical snapshot/decision.
  useEffect(() => {
    const t = setTimeout(() => setResult(verifyCycle(cycle)), 180);
    return () => clearTimeout(t);
  }, [cycle]);

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            #{num}
          </span>
          <ActionChip kind={r.actionKind} />
        </div>
        <ResultBadge result={r.result} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
        <MetaRow
          left={
            <span>
              alloc{' '}
              <span className="mono" style={{ color: 'var(--text-dim)' }}>
                {fmtBps(r.preAllocBps.scspr)}→{fmtBps(r.postAllocBps.scspr)}
              </span>{' '}
              sCSPR
            </span>
          }
          right={
            <span className="mono" style={{ color: skipped ? 'var(--text-faint)' : 'var(--text)' }}>
              {skipped ? '—' : fmtUsd(Number(r.notionalUsd) / 1e6)}
            </span>
          }
        />
        <MetaRow
          dim
          left={<span className="mono">twap {fmtPrice(twap)}</span>}
          right={<span>{fmtAgo(Number(r.timestamp))}</span>}
        />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginTop: 9,
        }}
      >
        <HashChip hash={r.deployHash} href={deployUrl(r.deployHash)} />
        <button
          onClick={() => setOpen((o) => !o)}
          title="Show hash checks"
          style={{
            background: 'none',
            border: 0,
            cursor: 'pointer',
            padding: 0,
            font: 'inherit',
          }}
        >
          {result ? (
            <span
              className={result.ok ? 'pill tone-green' : 'pill tone-coral'}
              style={{ fontSize: 10 }}
            >
              <span className="dot" />
              {result.ok ? 'verified' : 'MISMATCH'}
            </span>
          ) : (
            <span className="pill tone-neutral mono" style={{ fontSize: 10 }}>
              verifying…
            </span>
          )}
        </button>
      </div>

      {open && result && (
        <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 5 }}>
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

export function ReceiptFeed({ history, freshId }: { history: Cycle[]; freshId: string | null }) {
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <h3 className="card-title">
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          Receipts
          <span className="label">append-only audit log</span>
        </span>
        <span className="pill tone-green" style={{ fontSize: 10 }}>
          <span className="dot" />
          {history.length} on-chain
        </span>
      </h3>
      {history.length === 0 ? (
        <div
          style={{ fontSize: 12, color: 'var(--text-faint)', padding: '20px 0', textAlign: 'center' }}
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
