/** Allocation panel (design.md §5.1) — managed book value, per-bucket USD, drift vs band. */
'use client';
import type { AllocationBps, Regime } from '@sentinel/shared';
import { RegimePill } from '../atoms';
import { POLICY } from '../../lib/chain';
import { fmtBps, fmtPrice, fmtUsd } from '../../lib/format';

const COLORS = {
  scspr: 'var(--green)',
  csprusd: 'var(--info)',
  cspr: 'var(--text-faint)',
};

const BUFFER_CSPR = 80; // fixed working buffer, excluded from alloc math

function Donut({ alloc, managedUsd }: { alloc: AllocationBps; managedUsd: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const segs: { key: keyof typeof COLORS; bps: number }[] = [
    { key: 'scspr', bps: alloc.scspr },
    { key: 'csprusd', bps: alloc.csprusd },
    { key: 'cspr', bps: alloc.cspr },
  ];
  let offset = 0;
  return (
    <div style={{ position: 'relative', width: 132, height: 132, flex: '0 0 auto' }}>
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
              strokeLinecap="butt"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
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
        <span className="mono" style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' }}>
          {fmtUsd(managedUsd, { compact: true })}
        </span>
        <span className="label" style={{ marginTop: 1 }}>
          managed
        </span>
      </div>
    </div>
  );
}

function LegendRow({
  swatch,
  label,
  bps,
  usd,
}: {
  swatch: string;
  label: string;
  bps: number;
  usd: number;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <span style={{ width: 9, height: 9, borderRadius: 3, background: swatch, flex: '0 0 auto' }} />
      <span style={{ flex: 1, fontSize: 12, color: 'var(--text-dim)' }}>{label}</span>
      <span className="mono" style={{ fontSize: 12, width: 50, textAlign: 'right' }}>
        {fmtBps(bps)}
      </span>
      <span
        className="mono"
        style={{ fontSize: 12, width: 56, textAlign: 'right', color: 'var(--text-faint)' }}
      >
        {fmtUsd(usd, { compact: true })}
      </span>
    </div>
  );
}

function Foot({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0' }}>
      <span className="label">{label}</span>
      <span className="mono" style={{ fontSize: 12 }}>
        {value}
      </span>
    </div>
  );
}

export function AllocationPanel({
  alloc,
  targetBps,
  regime,
  twapUsd,
  managedUsd,
}: {
  alloc: AllocationBps;
  targetBps: { scspr: number; csprusd: number };
  regime: Regime;
  twapUsd: number;
  managedUsd: number;
}) {
  const managedBps = alloc.scspr + alloc.csprusd || 1;
  const scsprUsd = (managedUsd * alloc.scspr) / managedBps;
  const csprusdUsd = (managedUsd * alloc.csprusd) / managedBps;
  const inBand = alloc.scspr >= POLICY.minScsprBps && alloc.scspr <= POLICY.maxScsprBps;

  return (
    <section className="card">
      <h3 className="card-title">
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          Allocation
          <span className="label">{fmtBps(targetBps.scspr)} sCSPR target</span>
        </span>
        <RegimePill regime={regime} />
      </h3>

      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <Donut alloc={alloc} managedUsd={managedUsd} />
        <div style={{ flex: 1 }}>
          <LegendRow swatch="var(--green)" label="sCSPR (grow)" bps={alloc.scspr} usd={scsprUsd} />
          <LegendRow
            swatch="var(--info)"
            label="csprUSD (protect)"
            bps={alloc.csprusd}
            usd={csprusdUsd}
          />
          <div style={{ marginTop: 6 }}>
            <span
              className={inBand ? 'pill tone-green' : 'pill tone-amber'}
              style={{ fontSize: 10 }}
            >
              <span className="dot" />
              {inBand ? 'Within band' : 'Out of band'}
            </span>
          </div>
        </div>
      </div>

      <hr className="divider" />
      <Foot label="CSPR/USD TWAP (Styks)" value={fmtPrice(twapUsd)} />
      <Foot label="Buffer (excl.)" value={`${BUFFER_CSPR} CSPR`} />
    </section>
  );
}
