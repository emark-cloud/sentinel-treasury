/**
 * Sentinel Treasury — dark command-center (design.md).
 * Three-zone body: state (left) → reasoning→action (center, protagonist) → proof (right).
 */
'use client';
import { useState } from 'react';
import { useLoop } from '../lib/useLoop';
import { useWallet } from '../lib/wallet';
import { useDepositor } from '../lib/depositor';
import { TopBar } from '../components/TopBar';
import { AllocationPanel } from '../components/panels/Allocation';
import { PositionPanel } from '../components/panels/Position';
import { GuardrailPanel } from '../components/panels/Guardrail';
import { X402Meter } from '../components/panels/X402Meter';
import { DebatePanel } from '../components/panels/Debate';
import { DecisionCard } from '../components/panels/Decision';
import { ActionCard } from '../components/panels/Action';
import { ReceiptFeed } from '../components/panels/ReceiptFeed';
import { DepositModal, WithdrawModal } from '../components/DepositWithdraw';

export default function Page() {
  const loop = useLoop();
  const wallet = useWallet();
  const depositor = useDepositor(wallet);
  const [modal, setModal] = useState<'deposit' | 'withdraw' | null>(null);
  const x402Active = loop.stage === 'perceive';

  // Allocation state — managed book value + the USD-normalized split: the real vault's holdings
  // when the backend is configured (depositor.vaultLive, account-independent — loads for any visitor),
  // else the demo scenario's figure. (Regime + target band stay agent-driven; those are policy/
  // reasoning, not vault state.)
  const managedUsd = depositor.vaultLive
    ? Number(depositor.vault.managedNavUsd) / 1e6
    : loop.managedUsd;
  const alloc = depositor.vaultLive ? depositor.vault.allocBps : loop.alloc;
  // Native CSPR USD (total − managed) — buffer + un-deployed deposits. The Allocation panel splits
  // out the part above the working buffer as "pending", so a fresh deposit shows before rebalance.
  const nativeUsd = depositor.vaultLive
    ? (Number(depositor.vault.totalNavUsd) - Number(depositor.vault.managedNavUsd)) / 1e6
    : 0;

  return (
    <div className="app-grid">
      <TopBar loop={loop} wallet={wallet} />

      {/* Left rail — state & trust (quiet, slow-changing). */}
      <div className="app-rail" style={{ gridArea: 'left' }}>
        <AllocationPanel
          alloc={alloc}
          targetBps={loop.targetBps}
          regime={loop.regime}
          twapUsd={loop.twapUsd}
          managedUsd={managedUsd}
          nativeUsd={nativeUsd}
        />
        <GuardrailPanel daySpentUsd={loop.daySpentUsd} paused={loop.paused} />
        <X402Meter x402={loop.x402} active={x402Active} />
        <PositionPanel
          wallet={wallet}
          depositor={depositor}
          onDeposit={() => {
            depositor.resetTx();
            setModal('deposit');
          }}
          onWithdraw={() => {
            depositor.resetTx();
            setModal('withdraw');
          }}
        />
      </div>

      {/* Center — reasoning → action (the protagonist; dims when paused). */}
      <div
        style={{
          gridArea: 'center',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          overflowY: 'auto',
          paddingTop: 14,
          position: 'relative',
          opacity: loop.paused ? 0.35 : 1,
          filter: loop.paused ? 'saturate(0.5)' : 'none',
          transition: 'opacity 0.25s ease, filter 0.25s ease',
          pointerEvents: loop.paused ? 'none' : 'auto',
        }}
      >
        {loop.paused && (
          <div
            style={{
              position: 'absolute',
              top: 14,
              left: 0,
              right: 0,
              display: 'flex',
              justifyContent: 'center',
              zIndex: 5,
              pointerEvents: 'none',
            }}
          >
            <span className="pill tone-coral" style={{ fontSize: 13, padding: '6px 14px' }}>
              ⏸ Vault paused by owner — agent cannot act
            </span>
          </div>
        )}
        <DebatePanel
          cycle={loop.cycle}
          revealedTurns={loop.revealedTurns}
          consensus={loop.consensus}
        />
        <DecisionCard cycle={loop.cycle} show={loop.consensus} />
        <ActionCard
          cycle={loop.cycle}
          execStatus={loop.execStatus}
          showDeployHash={loop.showDeployHash}
        />
      </div>

      {/* Right rail — proof (accumulates; the payoff). */}
      <div
        style={{
          gridArea: 'right',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          paddingTop: 14,
        }}
      >
        <ReceiptFeed history={loop.history} freshId={loop.freshReceiptId} />
      </div>

      {modal === 'deposit' && (
        <DepositModal wallet={wallet} depositor={depositor} onClose={() => setModal(null)} />
      )}
      {modal === 'withdraw' && (
        <WithdrawModal wallet={wallet} depositor={depositor} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
