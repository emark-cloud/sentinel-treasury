/** Allocation panel (design.md §5.1) — actual vs target weights + drift, single accented focal metric. */
'use client';
import type { AllocationBps } from '@sentinel/shared';
import { fmtBps } from '../../lib/format';

const COLORS = {
  scspr: 'var(--green)',
  csprusd: 'var(--info)',
  cspr: 'var(--text-faint)',
};

function Donut({ alloc }: { alloc: AllocationBps }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const segs: { key: keyof typeof COLORS; bps: number }[] = [
    { key: 'scspr', bps: alloc.scspr },
    { key: 'csprusd', bps: alloc.csprusd },
    { key: 'cspr', bps: alloc.cspr },
  ];
  let offset = 0;
  return (
    <svg width="132" height="132" viewBox="0 0 132 132" style={{ transform: 'rotate(-90deg)' }}>
      <circle cx="66" cy="66" r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="14" />
      {segs.map((s) => {
        const len = (s.bps / 10000) * c;
        const el = (
          <circle
            key={s.key}
            cx="66"
            cy="66"
            r={r}
            fill="none"
            stroke={COLORS[s.key]}
            strokeWidth="14"
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-offset}
            style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
          />
        );
        offset += len;
        return el;
      })}
    </svg>
  );
}

function Row({
  swatch,
  label,
  actual,
  target,
}: {
  swatch: string;
  label: string;
  actual: number;
  target?: number;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '3px 0' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: swatch }} />
      <span style={{ flex: 1, color: 'var(--text-dim)' }}>{label}</span>
      <span className="mono" style={{ width: 48, textAlign: 'right' }}>
        {fmtBps(actual)}
      </span>
      <span className="mono" style={{ width: 56, textAlign: 'right', color: 'var(--text-faint)' }}>
        {target !== undefined ? `→ ${fmtBps(target)}` : '—'}
      </span>
    </div>
  );
}

export function AllocationPanel({
  alloc,
  targetBps,
}: {
  alloc: AllocationBps;
  targetBps: { scspr: number; csprusd: number };
}) {
  const driftBps = alloc.scspr - targetBps.scspr;
  const drifting = Math.abs(driftBps) > 200;
  return (
    <section className="card">
      <h3 className="card-title">
        Allocation
        <span className="label">USD-normalized</span>
      </h3>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div style={{ position: 'relative', width: 132, height: 132 }}>
          <Donut alloc={alloc} />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span className="label">drift</span>
            <span
              className="mono"
              style={{
                fontSize: 18,
                color: drifting ? 'var(--amber)' : 'var(--green)',
              }}
            >
              {driftBps >= 0 ? '+' : ''}
              {fmtBps(driftBps)}
            </span>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 2 }}>
            <span className="label" style={{ width: 48, textAlign: 'right' }}>
              actual
            </span>
            <span className="label" style={{ width: 56, textAlign: 'right' }}>
              target
            </span>
          </div>
          <Row
            swatch="var(--green)"
            label="sCSPR (grow)"
            actual={alloc.scspr}
            target={targetBps.scspr}
          />
          <Row
            swatch="var(--info)"
            label="csprUSD (protect)"
            actual={alloc.csprusd}
            target={targetBps.csprusd}
          />
          <Row swatch="var(--text-faint)" label="CSPR (buffer)" actual={alloc.cspr} />
        </div>
      </div>
    </section>
  );
}
