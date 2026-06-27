/** Persistent top bar — loop nav + live status + Pause + collapsed demo menu + Testnet tag. */
'use client';
import { useState } from 'react';
import { LOOP_STAGES, type LoopStage } from '../lib/types';
import type { LoopApi } from '../lib/useLoop';
import type { WalletApi } from '../lib/wallet';
import { RegimePill } from './atoms';
import { truncHash, fmtAgo } from '../lib/format';

function WalletChip({ wallet }: { wallet: WalletApi }) {
  if (!wallet.connected) {
    return (
      <button className="btn" onClick={wallet.connect} disabled={wallet.connecting} title="Connect a Casper wallet">
        {wallet.connecting ? 'Connecting…' : '⊕ Connect Wallet'}
      </button>
    );
  }
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
      title={wallet.isReal ? 'Casper Wallet connected' : 'Demo account (no chain activity)'}
    >
      <span className={`pill ${wallet.isReal ? 'tone-green' : 'tone-amber'}`} style={{ fontFamily: 'var(--font-mono)' }}>
        {wallet.isReal ? '' : 'demo '}
        {truncHash(wallet.activeKey ?? '')}
      </span>
      <button className="btn" onClick={wallet.disconnect} title="Disconnect" style={{ padding: '4px 8px' }}>
        ⏻
      </button>
    </span>
  );
}

const STAGE_LABEL: Record<(typeof LOOP_STAGES)[number], string> = {
  perceive: 'Perceive',
  decide: 'Decide',
  act: 'Act',
  prove: 'Prove',
};

function stageStatus(
  stage: LoopStage,
  s: (typeof LOOP_STAGES)[number],
): 'active' | 'done' | 'idle' {
  if (stage === 'idle') return 'idle';
  const order = LOOP_STAGES.indexOf(s);
  const cur = LOOP_STAGES.indexOf(stage as (typeof LOOP_STAGES)[number]);
  if (order === cur) return 'active';
  if (order < cur) return 'done';
  return 'idle';
}

/** Loop nav rendered as tabs; the active stage underlines, completed stages go green. */
function LoopNav({ stage }: { stage: LoopStage }) {
  return (
    <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {LOOP_STAGES.map((st) => {
        const status = stageStatus(stage, st);
        const color =
          status === 'active' ? 'var(--info)' : status === 'done' ? 'var(--green)' : 'var(--text-faint)';
        return (
          <span
            key={st}
            style={{
              fontSize: 12,
              padding: '4px 8px',
              color: status === 'idle' ? 'var(--text-faint)' : 'var(--text)',
              fontWeight: status === 'active' ? 500 : 400,
              borderBottom: `2px solid ${status === 'active' ? color : 'transparent'}`,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            {status !== 'idle' && (
              <span className={status === 'active' ? 'dot pulse' : 'dot'} style={{ color, width: 6, height: 6 }} />
            )}
            {STAGE_LABEL[st]}
          </span>
        );
      })}
    </nav>
  );
}

/** Relative "in 12m" formatter for the next scheduled run. */
function fmtIn(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ts - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/**
 * Live status chip — the agent's real operating state (design.md: the agent is the protagonist).
 * Shows "running" while a cycle animates, otherwise the schedule (last/next run); falls back to a
 * quiet "demo mode" tag when no runner backend is configured.
 */
function StatusChip({ loop }: { loop: LoopApi }) {
  if (!loop.live) {
    return (
      <span className="pill tone-amber" style={{ fontSize: 10 }} title="No runner backend configured — running on the demo source">
        demo mode
      </span>
    );
  }
  if (loop.running) {
    return (
      <span className="pill tone-info" style={{ fontSize: 10 }}>
        <span className="dot pulse" />
        agent running
      </span>
    );
  }
  const r = loop.runner;
  const next = r?.nextRunAt ? `next run ${fmtIn(r.nextRunAt)}` : 'scheduled';
  const last = r?.lastRunAt ? ` · last ${fmtAgo(r.lastRunAt)}` : '';
  return (
    <span
      className="pill tone-green"
      style={{ fontSize: 10 }}
      title={r ? `Managing ${r.accountCount} account(s) every ${Math.round(r.intervalMs / 60000)}m` : 'Agent live'}
    >
      <span className="dot" />
      agent live · {next}
      {last}
    </span>
  );
}

/** Collapsed demo menu — the scenario trigger is now a secondary control, clearly tagged (§15.3). */
function DemoMenu({ loop }: { loop: LoopApi }) {
  const [open, setOpen] = useState(false);
  const { running, paused, regime, inject, reset } = loop;
  const busy = running || paused;
  return (
    <div style={{ position: 'relative' }}>
      <button
        className="btn"
        onClick={() => setOpen((o) => !o)}
        title="Demo scenario triggers — simulate a market event (everything downstream is real on Testnet)"
        style={{
          padding: '6px 10px',
          border: '1px dashed var(--amber-line)',
          color: 'var(--amber)',
        }}
      >
        ⚡ Demo {open ? '▴' : '▾'}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
            minWidth: 230,
            border: '1px dashed var(--amber-line)',
            background: 'var(--surface-2)',
            borderRadius: 'var(--r-ctl)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, color: 'var(--amber)', fontWeight: 500 }}>demo ▸ scenario</span>
            <RegimePill regime={regime} />
          </div>
          <p style={{ fontSize: 10, color: 'var(--text-faint)', margin: 0, lineHeight: 1.4 }}>
            Injects a simulated market event into the perception layer. The reasoning, the capped tx,
            and the receipt are real on Testnet.
          </p>
          <button className="btn" disabled={busy} onClick={() => inject('shock')} style={{ justifyContent: 'flex-start' }}>
            ⚡ Price shock
          </button>
          <button className="btn" disabled={busy} onClick={() => inject('crunch')} style={{ justifyContent: 'flex-start' }}>
            ☷ Liquidity crunch
          </button>
          <button className="btn" disabled={busy} onClick={() => inject('calm')} style={{ justifyContent: 'flex-start' }}>
            ☼ Calm returns
          </button>
          <button className="btn" onClick={reset} disabled={running} title="Reset the demo feed (re-loads live data when configured)">
            ↻ Reset demo
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar({ loop, wallet }: { loop: LoopApi; wallet: WalletApi }) {
  const { stage, paused, togglePause } = loop;
  return (
    <header
      style={{
        gridArea: 'top',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '0 18px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(10,11,13,0.7)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ color: 'var(--green)', fontSize: 20 }}>◆</span>
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
            <span style={{ fontWeight: 600, fontSize: 19, letterSpacing: '-0.01em' }}>Sentinel</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Treasury
            </span>
          </span>
        </span>
        <span style={{ height: 20, width: 1, background: 'var(--border-strong)' }} />
        <LoopNav stage={stage} />
        <StatusChip loop={loop} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <DemoMenu loop={loop} />

        <button
          className={paused ? 'btn btn-danger' : 'btn'}
          onClick={togglePause}
          title="Owner kill switch — agent cannot act while paused"
        >
          {paused ? '▶ Unpause' : '⏸ Pause'}
        </button>

        <WalletChip wallet={wallet} />

        <span className="pill tone-info" style={{ fontFamily: 'var(--font-mono)' }}>
          Testnet
        </span>
      </div>
    </header>
  );
}
