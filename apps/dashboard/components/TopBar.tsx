/** Persistent top bar — loop stepper + scenario (demo) + Pause + Testnet tag (design.md §3, §5.2, §5.9). */
'use client';
import { LOOP_STAGES, type LoopStage } from '../lib/types';
import type { LoopApi } from '../lib/useLoop';
import type { WalletApi } from '../lib/wallet';
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

function LoopStepper({ stage }: { stage: LoopStage }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {LOOP_STAGES.map((st, i) => {
        const status = stageStatus(stage, st);
        const color =
          status === 'active'
            ? 'var(--info)'
            : status === 'done'
              ? 'var(--green)'
              : 'var(--text-faint)';
        return (
          <div key={st} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                className={status === 'active' ? 'dot pulse' : 'dot'}
                style={{ color, width: 7, height: 7 }}
              />
              <span
                style={{
                  fontSize: 12,
                  color: status === 'idle' ? 'var(--text-faint)' : 'var(--text)',
                  fontWeight: status === 'active' ? 500 : 400,
                }}
              >
                {STAGE_LABEL[st]}
              </span>
            </span>
            {i < LOOP_STAGES.length - 1 && (
              <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>›</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function TopBar({ loop, wallet }: { loop: LoopApi; wallet: WalletApi }) {
  const { stage, running, paused, inject, togglePause } = loop;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
          <span style={{ color: 'var(--green)', fontSize: 15 }}>◆</span> Sentinel Treasury
        </span>
        <span style={{ height: 18, width: 1, background: 'var(--border-strong)' }} />
        <LoopStepper stage={stage} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Scenario controls — visibly tagged demo, styled apart (design.md §8). */}
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
          <span style={{ fontSize: 10, color: 'var(--amber)', fontWeight: 500 }}>
            demo ▸ scenario
          </span>
          <button
            className="btn"
            disabled={busy}
            onClick={() => inject('shock')}
            style={{ padding: '4px 9px' }}
          >
            ⚡ Price shock
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => inject('calm')}
            style={{ padding: '4px 9px' }}
          >
            ☼ Calm
          </button>
        </div>

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
