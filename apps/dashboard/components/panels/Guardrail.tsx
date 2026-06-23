/** Guardrail panel (design.md §5.7) — caps, whitelist, slippage, key weights, owner Pause. */
'use client';
import { CapMeter, HashChip } from '../atoms';
import { KEY_WEIGHTS, POLICY, WHITELIST, contractUrl } from '../../lib/chain';
import { fmtBps } from '../../lib/format';

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div
      style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}
    >
      <span className="label">{label}</span>
      <span className="mono" style={{ color: tone ?? 'var(--text)' }}>
        {value}
      </span>
    </div>
  );
}

export function GuardrailPanel({
  daySpentUsd,
  paused,
  onTogglePause,
}: {
  daySpentUsd: number; // micros
  paused: boolean;
  onTogglePause: () => void;
}) {
  const dailyCap = Number(POLICY.dailyCapUsd) / 1e6;
  const used = daySpentUsd / 1e6;
  return (
    <section className="card" style={paused ? { borderColor: 'var(--coral-line)' } : undefined}>
      <h3 className="card-title">
        Guardrails
        <span className="label">enforced on-chain</span>
      </h3>

      <CapMeter usedUsd={used} totalUsd={dailyCap} label="Daily cap · used / remaining" />

      <div style={{ marginTop: 12 }}>
        <Stat
          label="Per-action cap"
          value={`$${(Number(POLICY.perActionCapUsd) / 1e6).toFixed(0)}`}
        />
        <Stat label="Slippage ceiling" value={fmtBps(POLICY.maxSlippageBps)} />
        <Stat
          label="Alloc band (sCSPR)"
          value={`${fmtBps(POLICY.minScsprBps)} – ${fmtBps(POLICY.maxScsprBps)}`}
        />
      </div>

      <hr className="divider" />

      <div className="label" style={{ marginBottom: 6 }}>
        Contract whitelist
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {WHITELIST.map((w) => (
          <div
            key={w.hash}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{w.label}</span>
            <HashChip hash={w.hash} href={contractUrl(w.hash)} />
          </div>
        ))}
      </div>

      <hr className="divider" />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="label">Key weights (§4.3)</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
            agent {KEY_WEIGHTS.agentWeight} · owner {KEY_WEIGHTS.ownerWeight} · key-mgmt thresh{' '}
            {KEY_WEIGHTS.keyManagementThreshold}
          </div>
        </div>
      </div>

      <button
        className={paused ? 'btn btn-danger' : 'btn'}
        onClick={onTogglePause}
        style={{ width: '100%', marginTop: 12 }}
      >
        {paused ? '▶ Owner: unpause vault' : '⏸ Owner: pause vault'}
      </button>
    </section>
  );
}
