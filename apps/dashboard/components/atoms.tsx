/** Small reusable atoms (design.md §6) — pills, badges, chips, meters. */
'use client';
import { useState } from 'react';
import type { ActionKind, ActionResult, Regime } from '@sentinel/shared';
import { truncHash } from '../lib/format';

type Tone = 'green' | 'amber' | 'coral' | 'info' | 'neutral';

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`pill tone-${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

const REGIME_TONE: Record<Regime, Tone> = {
  Calm: 'green',
  Elevated: 'amber',
  Stressed: 'coral',
};

export function RegimePill({ regime }: { regime: Regime }) {
  return <Pill tone={REGIME_TONE[regime]}>{regime}</Pill>;
}

export function ResultBadge({ result }: { result: ActionResult }) {
  if (result === 'Success') return <Pill tone="green">✔ on-chain</Pill>;
  if (result === 'Reverted') return <Pill tone="coral">Reverted</Pill>;
  return <Pill tone="neutral">Skipped</Pill>;
}

export function SourceFlag({
  consensus,
  source,
}: {
  consensus: boolean;
  source: 'llm' | 'fallback';
}) {
  return source === 'fallback' || !consensus ? (
    <Pill tone="amber">fallback</Pill>
  ) : (
    <Pill tone="green">consensus</Pill>
  );
}

const GROW: ActionKind[] = ['Stake', 'SwapToRisk'];
const PROTECT: ActionKind[] = ['Unstake', 'SwapToStable'];

export function ActionChip({ kind }: { kind: ActionKind }) {
  const tone: Tone = GROW.includes(kind) ? 'green' : PROTECT.includes(kind) ? 'coral' : 'neutral';
  return <Pill tone={tone}>{kind}</Pill>;
}

export function ProvenanceTag({ label }: { label: 'VERIFIED' | 'COMPUTED' | 'ESTIMATED' }) {
  const tone: Tone = label === 'VERIFIED' ? 'green' : label === 'COMPUTED' ? 'info' : 'amber';
  return (
    <span className={`pill tone-${tone}`} style={{ fontSize: 9, padding: '1px 6px' }}>
      {label.toLowerCase()}
    </span>
  );
}

export function HashChip({ hash, href, label }: { hash: string; href?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(hash).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1100);
      },
      () => {},
    );
  };
  return (
    <span className="hashchip">
      {label && <span style={{ color: 'var(--text-faint)' }}>{label}</span>}
      <span>{truncHash(hash)}</span>
      <button onClick={copy} title="Copy" aria-label="Copy hash">
        {copied ? '✓' : '⧉'}
      </button>
      {href && (
        <a href={href} target="_blank" rel="noreferrer" title="Open on cspr.live">
          ↗
        </a>
      )}
    </span>
  );
}

/** Segmented used/remaining cap meter (Vaulta pattern, design.md §5.7). */
export function CapMeter({
  usedUsd,
  totalUsd,
  label,
}: {
  usedUsd: number;
  totalUsd: number;
  label: string;
}) {
  const pct = Math.min(100, (usedUsd / totalUsd) * 100);
  const near = pct >= 80;
  const color = near ? 'var(--amber)' : 'var(--info)';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="label">{label}</span>
        <span
          className="mono"
          style={{ fontSize: 11, color: near ? 'var(--amber)' : 'var(--text-dim)' }}
        >
          ${usedUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })} / $
          {totalUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
        </span>
      </div>
      <div className="meter">
        <span style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
