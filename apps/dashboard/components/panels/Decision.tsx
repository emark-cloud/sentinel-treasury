/** Decision card (design.md §5.4) — chosen regime, target, concrete action, slippage. */
'use client';
import type { Cycle } from '../../lib/types';
import { ActionChip, RegimePill } from '../atoms';
import { fmtAmount, fmtBps } from '../../lib/format';

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}

export function DecisionCard({ cycle, show }: { cycle: Cycle | null; show: boolean }) {
  if (!cycle || !show) {
    return (
      <section className="card" style={{ opacity: 0.5 }}>
        <h3 className="card-title">
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            Decision
            <span className="label">consensus → execution</span>
          </span>
        </h3>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-faint)',
            textAlign: 'center',
            padding: '24px 0',
          }}
        >
          Awaiting deliberation outcome
        </div>
      </section>
    );
  }
  const a = cycle.decision.finalAction;
  return (
    <section className="card snap-in">
      <h3 className="card-title">
        Decision
        <span className="label">cycle {cycle.id}</span>
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <Cell label="Regime">
          <RegimePill regime={cycle.regime} />
        </Cell>
        <Cell label="Target (sCSPR/csprUSD)">
          <span className="mono">
            {fmtBps(cycle.targetBps.scspr)} / {fmtBps(cycle.targetBps.csprusd)}
          </span>
        </Cell>
        <Cell label="Action">
          <ActionChip kind={a.kind} />
        </Cell>
        <Cell label="Expected slippage">
          <span className="mono">{fmtBps(cycle.proposal.expectedSlippageBps)}</span>
        </Cell>
        <Cell label="Amount in">
          <span className="mono">{fmtAmount(a.amount, a.asset)}</span>
        </Cell>
        <Cell label="Min out">
          <span className="mono">{a.minOut ? Number(a.minOut).toLocaleString() : '—'}</span>
        </Cell>
        <Cell label="Notional (USD)">
          <span className="mono">${(Number(cycle.notionalUsd) / 1e6).toFixed(0)}</span>
        </Cell>
        <Cell label="Source">
          <span className="mono">{cycle.decision.source}</span>
        </Cell>
      </div>
    </section>
  );
}
