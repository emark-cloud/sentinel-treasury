/** Allocation panel (design.md §5.1) — managed book value, per-bucket USD, drift vs band. */
'use client';
import type { AllocationBps, Regime } from '@sentinel/shared';
import { RegimePill } from '../atoms';
import { POLICY } from '../../lib/chain';
import { fmtBps, fmtPrice, fmtUsd } from '../../lib/format';

const COLORS = {
  scspr: 'var(--green)',
  csprusd: 'var(--info)',
  pending: 'var(--amber)',
};

const BUFFER_CSPR = 80; // fixed working buffer, excluded from alloc math

interface Seg {
  key: keyof typeof COLORS;
  usd: number;
}

function Donut({
  segs,
  managedUsd,
  pendingUsd,
  loading,
}: {
  segs: Seg[];
  managedUsd: number;
  pendingUsd: number;
  loading?: boolean;
}) {
  const size = 156;
  const mid = size / 2;
  const r = 62;
  const sw = 15;
  const c = 2 * Math.PI * r;
  const basis = segs.reduce((s, x) => s + Math.max(0, x.usd), 0);
  let offset = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: '0 0 auto' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={mid} cy={mid} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={sw} />
        {!loading && segs.map((s) => {
          const len = basis > 0 ? (Math.max(0, s.usd) / basis) * c : 0;
          const el = (
            <circle
              key={s.key}
              cx={mid}
              cy={mid}
              r={r}
              fill="none"
              stroke={COLORS[s.key]}
              strokeWidth={sw}
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
        {loading ? (
          <span className="skel" style={{ width: 76, height: 24 }} />
        ) : (
          <span className="mono" style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em' }}>
            {fmtUsd(managedUsd, { compact: true })}
          </span>
        )}
        <span className="label" style={{ marginTop: loading ? 6 : 1 }}>
          managed
        </span>
        {!loading && pendingUsd > 0.005 && (
          <span className="mono" style={{ marginTop: 3, fontSize: 10, color: 'var(--amber)' }}>
            +{fmtUsd(pendingUsd, { compact: true })} pending
          </span>
        )}
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
      <span style={{ flex: 1, fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{label}</span>
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

/** Legend-row-shaped skeleton: swatch + label + two right-aligned figure slots. */
function SkelRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <span className="skel" style={{ width: 9, height: 9, borderRadius: 3, flex: '0 0 auto' }} />
      <span className="skel" style={{ flex: 1, height: 11, maxWidth: 96 }} />
      <span className="skel" style={{ width: 36, height: 11 }} />
      <span className="skel" style={{ width: 44, height: 11 }} />
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
  nativeUsd,
  loading = false,
}: {
  alloc: AllocationBps;
  targetBps: { scspr: number; csprusd: number };
  regime: Regime;
  twapUsd: number;
  managedUsd: number;
  /** USD value of the vault's native CSPR holdings (buffer + un-deployed deposits). */
  nativeUsd: number;
  /** Hold a skeleton until the live vault TVL settles — avoids flashing the demo seed book. */
  loading?: boolean;
}) {
  // Managed book split (sCSPR grow / csprUSD protect), USD-weighted.
  const managedBps = alloc.scspr + alloc.csprusd || 1;
  const scsprUsd = (managedUsd * alloc.scspr) / managedBps;
  const csprusdUsd = (managedUsd * alloc.csprusd) / managedBps;

  // Native CSPR beyond the fixed working buffer is deposited capital awaiting deployment by the
  // agent's next rebalance — surface it so a fresh deposit is visible before it's allocated.
  const bufferUsd = BUFFER_CSPR * twapUsd;
  const pendingUsd = Math.max(0, nativeUsd - bufferUsd);

  // Donut + legend share one basis so the ring matches the percentages.
  const basis = scsprUsd + csprusdUsd + pendingUsd || 1;
  const segs: Seg[] = [
    { key: 'scspr', usd: scsprUsd },
    { key: 'csprusd', usd: csprusdUsd },
    { key: 'pending', usd: pendingUsd },
  ];
  const toBps = (usd: number) => Math.round((Math.max(0, usd) / basis) * 10000);

  // The sCSPR band applies to the *managed* book (sCSPR vs csprUSD); it's undefined while every
  // dollar is still pending deployment.
  const managedScsprBps = managedUsd > 0 ? Math.round((scsprUsd / managedUsd) * 10000) : null;
  const inBand =
    managedScsprBps !== null &&
    managedScsprBps >= POLICY.minScsprBps &&
    managedScsprBps <= POLICY.maxScsprBps;

  return (
    <section className="card">
      <h3 className="card-title">
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          Allocation
          <span className="label">{fmtBps(targetBps.scspr)} sCSPR target</span>
        </span>
        <RegimePill regime={regime} />
      </h3>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <Donut segs={segs} managedUsd={managedUsd} pendingUsd={pendingUsd} loading={loading} />
        <div style={{ width: '100%' }}>
          {loading ? (
            <>
              <SkelRow />
              <SkelRow />
              <div style={{ marginTop: 8 }}>
                <span className="skel" style={{ width: 92, height: 16, borderRadius: 999 }} />
              </div>
            </>
          ) : (
            <>
              <LegendRow swatch="var(--green)" label="sCSPR (grow)" bps={toBps(scsprUsd)} usd={scsprUsd} />
              <LegendRow
                swatch="var(--info)"
                label="csprUSD (protect)"
                bps={toBps(csprusdUsd)}
                usd={csprusdUsd}
              />
              {pendingUsd > 0.005 && (
                <LegendRow
                  swatch="var(--amber)"
                  label="CSPR (pending)"
                  bps={toBps(pendingUsd)}
                  usd={pendingUsd}
                />
              )}
              <div style={{ marginTop: 8 }}>
                {managedScsprBps === null ? (
                  <span className="pill tone-amber" style={{ fontSize: 10 }}>
                    <span className="dot" />
                    Awaiting allocation
                  </span>
                ) : (
                  <span className={inBand ? 'pill tone-green' : 'pill tone-amber'} style={{ fontSize: 10 }}>
                    <span className="dot" />
                    {inBand ? 'Within band' : 'Out of band'}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <hr className="divider" />
      <Foot label="CSPR/USD TWAP (Styks)" value={fmtPrice(twapUsd)} />
      <Foot label="Buffer (excl.)" value={`${BUFFER_CSPR} CSPR`} />
    </section>
  );
}
