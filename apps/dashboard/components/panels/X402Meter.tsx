/** x402 meter (design.md §5.8) — paid pulls, CSPR spent, hourly budget, last settle tx. */
'use client';
import { HashChip } from '../atoms';
import { X402_HOURLY_CAP_CSPR, deployUrl } from '../../lib/chain';
import type { X402State } from '../../lib/types';

function BigStat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ flex: 1 }}>
      <div className="mono" style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' }}>
        {value}
      </div>
      <div className="label">{label}</div>
    </div>
  );
}

export function X402Meter({ x402, active }: { x402: X402State; active: boolean }) {
  const pct = Math.min(100, (x402.csprSpent / X402_HOURLY_CAP_CSPR) * 100);
  return (
    <section className="card">
      <h3 className="card-title">
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          x402 paid pulls
          <span className="label">machine-payment</span>
        </span>
        <span style={{ color: active ? 'var(--info)' : 'var(--text-faint)', fontSize: 12 }}>⚡</span>
      </h3>

      <div style={{ display: 'flex', gap: 14 }}>
        <BigStat value={String(x402.paidPulls)} label="pulls this session" />
        <BigStat value={x402.csprSpent.toFixed(1)} label="CSPR spent" />
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span className="label">Hourly budget</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {x402.csprSpent.toFixed(1)} / {X402_HOURLY_CAP_CSPR} CSPR
          </span>
        </div>
        <div className="meter">
          <span style={{ width: `${pct}%`, background: 'var(--info)' }} />
        </div>
      </div>

      <hr className="divider" />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="label">Status</span>
        <span
          className={active ? 'pill tone-info' : 'mono'}
          style={{ fontSize: active ? 11 : 12, color: active ? undefined : 'var(--text-dim)' }}
        >
          {active ? 'paid pull…' : 'idle'}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <span className="label">Last settle tx</span>
        {x402.lastSettleTx ? (
          <HashChip hash={x402.lastSettleTx} href={deployUrl(x402.lastSettleTx)} />
        ) : (
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            —
          </span>
        )}
      </div>
    </section>
  );
}
