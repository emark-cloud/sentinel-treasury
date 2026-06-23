/** x402 meter (design.md §5.8) — paid pulls, CSPR spent, last settle tx. */
'use client';
import { HashChip } from '../atoms';
import { deployUrl } from '../../lib/chain';
import type { X402State } from '../../lib/types';

export function X402Meter({ x402, active }: { x402: X402State; active: boolean }) {
  return (
    <section className="card">
      <h3 className="card-title">
        x402 premium feed
        <span className={active ? 'pill tone-info' : 'label'} style={{ fontSize: 10 }}>
          {active ? 'paid pull…' : 'idle'}
        </span>
      </h3>
      <div style={{ display: 'flex', gap: 18 }}>
        <div>
          <div className="label">Paid pulls</div>
          <div className="mono" style={{ fontSize: 18 }}>
            {x402.paidPulls}
          </div>
        </div>
        <div>
          <div className="label">CSPR spent</div>
          <div className="mono" style={{ fontSize: 18 }}>
            {x402.csprSpent}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="label" style={{ marginBottom: 4 }}>
          Last settle tx
        </div>
        {x402.lastSettleTx ? (
          <HashChip hash={x402.lastSettleTx} href={deployUrl(x402.lastSettleTx)} />
        ) : (
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            —
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 8 }}>
        1 pull / cycle · hourly CSPR cap · duplicate suppression
      </div>
    </section>
  );
}
