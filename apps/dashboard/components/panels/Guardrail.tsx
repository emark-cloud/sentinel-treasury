/** Guardrail panel (design.md §5.7) — caps, whitelist, slippage, key weights. Enforced in WASM. */
'use client';
import { HashChip } from '../atoms';
import { KEY_WEIGHTS, POLICY, WHITELIST, contractUrl } from '../../lib/chain';
import { fmtBps, fmtUsd } from '../../lib/format';

function GridStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 2 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 14 }}>
        {value}
      </div>
    </div>
  );
}

export function GuardrailPanel({
  daySpentUsd,
  paused,
}: {
  daySpentUsd: number; // micros
  paused: boolean;
}) {
  const dailyCap = Number(POLICY.dailyCapUsd) / 1e6;
  const used = daySpentUsd / 1e6;
  const remaining = Math.max(0, dailyCap - used);
  const pct = Math.min(100, (used / dailyCap) * 100);
  const near = pct >= 80;

  return (
    <section className="card" style={paused ? { borderColor: 'var(--coral-line)' } : undefined}>
      <h3 className="card-title">
        Guardrails
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span className="label">enforced on-chain (WASM)</span>
          <span style={{ color: 'var(--green)', fontSize: 12 }} title="Enforced below the agent's reach">
            ⛉
          </span>
        </span>
      </h3>

      {/* Daily cap meter */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="label">Daily cap</span>
        <span className="mono" style={{ fontSize: 11, color: near ? 'var(--amber)' : 'var(--text-dim)' }}>
          {fmtUsd(used)} used of {fmtUsd(dailyCap)}
        </span>
      </div>
      <div className="meter">
        <span style={{ width: `${pct}%`, background: near ? 'var(--amber)' : 'var(--info)' }} />
      </div>
      <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', textAlign: 'right', marginTop: 4 }}>
        {fmtUsd(remaining)} remaining
      </div>

      {/* 2×2 invariants */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '12px 14px',
          marginTop: 14,
        }}
      >
        <GridStat label="Per-action cap" value={fmtUsd(Number(POLICY.perActionCapUsd) / 1e6)} />
        <GridStat label="Slippage ceiling" value={fmtBps(POLICY.maxSlippageBps)} />
        <GridStat
          label="sCSPR band"
          value={`${fmtBps(POLICY.minScsprBps)}–${fmtBps(POLICY.maxScsprBps)}`}
        />
        <GridStat
          label="Key weights"
          value={`${KEY_WEIGHTS.agentWeight} / ${KEY_WEIGHTS.keyManagementThreshold}`}
        />
      </div>

      <hr className="divider" />

      <div className="label" style={{ marginBottom: 7 }}>
        Contract whitelist
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {WHITELIST.map((w) => (
          <div
            key={w.hash}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--green)' }}>✓</span>
              {w.label}
            </span>
            <HashChip hash={w.hash} href={contractUrl(w.hash)} />
          </div>
        ))}
      </div>
    </section>
  );
}
