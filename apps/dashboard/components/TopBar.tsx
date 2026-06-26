/** Persistent top bar — loop nav + scenario (demo) + Pause + Testnet tag (design.md §3, §5.2, §5.9). */
'use client';
import { LOOP_STAGES, type LoopStage } from '../lib/types';
import type { LoopApi } from '../lib/useLoop';
import type { WalletApi } from '../lib/wallet';
import { RegimePill } from './atoms';
import { truncHash } from '../lib/format';

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

export function TopBar({ loop, wallet }: { loop: LoopApi; wallet: WalletApi }) {
  const { stage, running, paused, regime, inject, togglePause, reset } = loop;
  const busy = running || paused;
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
        <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ color: 'var(--green)', fontSize: 15 }}>◆</span>
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
            <span style={{ fontWeight: 600, fontSize: 14, letterSpacing: '-0.01em' }}>Sentinel</span>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Treasury
            </span>
          </span>
        </span>
        <span
          className="hide-narrow"
          style={{ fontSize: 11, color: 'var(--text-dim)', maxWidth: '30ch', lineHeight: 1.25 }}
        >
          Autonomous on-chain treasury — acts under hard limits, proves every move.
        </span>
        <span style={{ height: 20, width: 1, background: 'var(--border-strong)' }} />
        <LoopNav stage={stage} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Scenario controls — visibly tagged demo, styled apart (design.md §8, spec §15.3). */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px 4px 10px',
            border: '1px dashed var(--amber-line)',
            background: 'var(--amber-dim)',
            borderRadius: 'var(--r-ctl)',
          }}
          title="Simulated market event — only the trigger is injected; everything downstream is real on Testnet"
        >
          <span style={{ fontSize: 10, color: 'var(--amber)', fontWeight: 500 }}>demo ▸ scenario</span>
          <RegimePill regime={regime} />
          <button className="btn" disabled={busy} onClick={() => inject('shock')} style={{ padding: '4px 9px' }}>
            ⚡ Price shock
          </button>
          <button className="btn" disabled={busy} onClick={() => inject('crunch')} style={{ padding: '4px 9px' }}>
            ☷ Liquidity crunch
          </button>
          <button className="btn" disabled={busy} onClick={() => inject('calm')} style={{ padding: '4px 9px' }}>
            ☼ Calm returns
          </button>
        </div>

        <button className="btn" onClick={reset} disabled={running} title="Reset the demo to a fresh resting book" style={{ padding: '6px 10px' }}>
          ↻ Reset
        </button>

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
