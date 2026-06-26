/** Debate panel (design.md §5.3) — the protagonist. Streaming Scout/Risk/Treasury turns. */
'use client';
import type { Cycle } from '../../lib/types';
import { ActionChip, ProvenanceTag, RegimePill, SourceFlag } from '../atoms';
import { fmtBps, fmtPrice, fmtUsd } from '../../lib/format';

type Role = 'Scout' | 'Risk' | 'Treasury';
const ROLE_TONE: Record<Role, string> = {
  Scout: 'var(--info)',
  Risk: 'var(--coral)',
  Treasury: 'var(--green)',
};

const AGENTS: { role: Role; tone: string }[] = [
  { role: 'Scout', tone: 'var(--info)' },
  { role: 'Risk', tone: 'var(--coral)' },
  { role: 'Treasury', tone: 'var(--green)' },
];

function TurnShell({
  role,
  tag,
  children,
}: {
  role: Role;
  tag: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="snap-in"
      style={{
        border: '1px solid var(--border)',
        borderLeft: `2px solid ${ROLE_TONE[role]}`,
        borderRadius: 'var(--r-ctl)',
        background: 'var(--surface-2)',
        padding: '10px 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: ROLE_TONE[role] }}>{role}</span>
        <span className="label">{tag}</span>
      </div>
      {children}
    </div>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55 }}>
      {children}
    </p>
  );
}

function ScoutTurn({ cycle }: { cycle: Cycle }) {
  const s = cycle.snapshot;
  return (
    <TurnShell role="Scout" tag="perception · snapshot">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '4px 16px',
          fontSize: 12,
        }}
      >
        <Field k="CSPR/USD TWAP" v={fmtPrice(s.csprUsdTwap)} prov="VERIFIED" />
        <Field k="CSPR/USD spot" v={fmtPrice(s.csprUsdSpot)} prov="VERIFIED" />
        <Field k="TWAP–spot divergence" v={fmtBps(s.twapSpotDivergenceBps)} prov="COMPUTED" />
        <Field k="1h volatility" v={`${s.volatility.annualizedPct.toFixed(0)}%`} prov="ESTIMATED" />
        <Field
          k="csprUSD pool depth"
          v={fmtUsd(s.liquidity.csprUsdPool.depthUsd, { compact: true })}
          prov="VERIFIED"
        />
        {s.premiumSignal && (
          <Field k="premium risk index" v={`${s.premiumSignal.riskIndex}/100`} prov="VERIFIED" />
        )}
      </div>
    </TurnShell>
  );
}

function Field({
  k,
  v,
  prov,
}: {
  k: string;
  v: string;
  prov: 'VERIFIED' | 'COMPUTED' | 'ESTIMATED';
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
      <span style={{ color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 5 }}>
        {k} <ProvenanceTag label={prov} />
      </span>
      <span className="mono">{v}</span>
    </div>
  );
}

function RiskVerdictTurn({ cycle }: { cycle: Cycle }) {
  const r = cycle.riskVerdict;
  return (
    <TurnShell role="Risk" tag="classify regime">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <RegimePill regime={r.regime} />
        <span className="mono" style={{ fontSize: 12 }}>
          risk {r.riskScore}/100
        </span>
        <span className="label">
          · hard limit: max sCSPR {fmtBps(r.hardLimits.maxScsprBps)} · cap $
          {r.hardLimits.maxActionUsd}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
        {r.drivers.map((d) => (
          <span key={d} className="pill tone-neutral" style={{ fontSize: 10 }}>
            {d}
          </span>
        ))}
      </div>
      <Prose>{r.rationale}</Prose>
    </TurnShell>
  );
}

function TreasuryTurn({ cycle }: { cycle: Cycle }) {
  const p = cycle.proposal;
  return (
    <TurnShell role="Treasury" tag="propose allocation">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <ActionChip kind={p.action.kind} />
        <span className="mono" style={{ fontSize: 12 }}>
          target {fmtBps(p.targetBps.scspr)} / {fmtBps(p.targetBps.csprusd)}
        </span>
        <span className="label">· expected slippage {fmtBps(p.expectedSlippageBps)}</span>
      </div>
      <Prose>{p.rationale}</Prose>
    </TurnShell>
  );
}

function RiskApproveTurn({ cycle }: { cycle: Cycle }) {
  const turn = cycle.decision.transcript.find((t) => t.role === 'Risk');
  const rejected = turn?.kind === 'reject';
  return (
    <TurnShell role="Risk" tag={rejected ? 'reject' : 'approve'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={rejected ? 'pill tone-coral' : 'pill tone-green'} style={{ fontSize: 11 }}>
          {rejected ? '✕ reject' : '✓ approve'}
        </span>
      </div>
      <Prose>{turn?.rationale}</Prose>
    </TurnShell>
  );
}

export function DebatePanel({
  cycle,
  revealedTurns,
  consensus,
}: {
  cycle: Cycle | null;
  revealedTurns: number;
  consensus: boolean;
}) {
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <h3 className="card-title">
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          Deliberation
          <span className="label">Scout · Risk · Treasury</span>
        </span>
        {cycle && consensus && <SourceFlag consensus={consensus} source={cycle.decision.source} />}
      </h3>

      {!cycle ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            minHeight: 220,
          }}
        >
          <div style={{ display: 'flex', gap: 14 }}>
            {AGENTS.map((a) => (
              <div
                key={a.role}
                title={a.role}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 15,
                  fontWeight: 500,
                  color: a.tone,
                  background: 'var(--surface-2)',
                  border: `1px solid ${a.tone}`,
                  opacity: 0.85,
                }}
              >
                {a.role[0]}
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Agents idle</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
              Inject a scenario to start a deliberation
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {revealedTurns >= 1 && <ScoutTurn cycle={cycle} />}
          {revealedTurns >= 2 && <RiskVerdictTurn cycle={cycle} />}
          {revealedTurns >= 3 && <TreasuryTurn cycle={cycle} />}
          {revealedTurns >= 4 && <RiskApproveTurn cycle={cycle} />}
          {consensus && (
            <div
              className="snap-in"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '8px',
                border: '1px solid var(--green-line)',
                background: 'var(--green-dim)',
                borderRadius: 'var(--r-ctl)',
                color: 'var(--green)',
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              ✓ Consensus reached — handing to execution
            </div>
          )}
        </div>
      )}
    </section>
  );
}
