/**
 * "Your Position" — the depositor's answer to "where are my funds and what are they worth?"
 * Shows shares, NAV/share index, USD value, % of pool, and the in-kind asset slice an immediate
 * withdraw would return. Connect CTA when no wallet; empty state at zero balance. (design.md §5.)
 */
'use client';
import type { DepositorApi } from '../../lib/depositor';
import type { WalletApi } from '../../lib/wallet';
import { fmtAmount, fmtBps, fmtUsdMicros, truncHash } from '../../lib/format';

const COLORS = { scspr: 'var(--green)', csprusd: 'var(--info)', cspr: 'var(--text-faint)' };

function StatRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0' }}>
      <span className="label">{label}</span>
      <span className="mono" style={{ fontSize: 13, color: accent ? 'var(--green)' : 'var(--text)' }}>
        {value}
      </span>
    </div>
  );
}

function AssetSlice({ k, motesOrUnits }: { k: keyof typeof COLORS; motesOrUnits: string }) {
  const asset = k === 'scspr' ? 'sCSPR' : k === 'csprusd' ? 'csprUSD' : 'CSPR';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '2px 0' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[k] }} />
      <span style={{ flex: 1, color: 'var(--text-dim)' }}>{asset}</span>
      <span className="mono" style={{ color: 'var(--text)' }}>{fmtAmount(motesOrUnits, asset)}</span>
    </div>
  );
}

export function PositionPanel({
  wallet,
  depositor,
  onDeposit,
  onWithdraw,
}: {
  wallet: WalletApi;
  depositor: DepositorApi;
  onDeposit: () => void;
  onWithdraw: () => void;
}) {
  const { position } = depositor;
  const empty =
    !position ||
    (position.balances.cspr === '0' && position.balances.scspr === '0' && position.balances.csprusd === '0');

  return (
    <section className="card">
      <h3 className="card-title">
        Your Position
        {wallet.connected &&
          (depositor.live ? (
            <span className="pill tone-green" style={{ fontSize: 9, padding: '1px 6px' }}>live</span>
          ) : (
            <span className="pill tone-amber" style={{ fontSize: 9, padding: '1px 6px' }}>demo</span>
          ))}
      </h3>

      {!wallet.connected ? (
        <div style={{ padding: '10px 2px', color: 'var(--text-dim)', fontSize: 12 }}>
          <p style={{ margin: '0 0 10px' }}>
            Connect a Casper wallet to deposit and track your own position in the treasury.
          </p>
          <button className="btn" onClick={wallet.connect} disabled={wallet.connecting} style={{ width: '100%' }}>
            {wallet.connecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        </div>
      ) : empty ? (
        <div style={{ padding: '8px 2px' }}>
          <p style={{ margin: '0 0 10px', color: 'var(--text-dim)', fontSize: 12 }}>
            No deposits yet. Deposit CSPR to open a position in the treasury the agent manages —
            withdraw your value anytime.
          </p>
          <button className="btn" onClick={onDeposit} style={{ width: '100%' }}>+ Deposit CSPR</button>
        </div>
      ) : (
        <>
          <StatRow label="value" value={fmtUsdMicros(position!.valueUsd)} accent />
          <div style={{ fontSize: 10, color: 'var(--text-faint)', padding: '2px 0' }}>
            your allocation: {fmtBps(position!.allocBps.scspr)} sCSPR · {fmtBps(position!.allocBps.csprusd)} stable · {fmtBps(position!.allocBps.cspr)} CSPR
          </div>

          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            <span className="label">your holdings (withdraw returns these)</span>
            <div style={{ marginTop: 4 }}>
              <AssetSlice k="scspr" motesOrUnits={position!.balances.scspr} />
              <AssetSlice k="csprusd" motesOrUnits={position!.balances.csprusd} />
              <AssetSlice k="cspr" motesOrUnits={position!.balances.cspr} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={onDeposit} style={{ flex: 1 }}>+ Deposit</button>
            <button className="btn" onClick={onWithdraw} style={{ flex: 1 }}>Withdraw</button>
          </div>
        </>
      )}

      {wallet.connected && (
        <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-faint)', display: 'flex', justifyContent: 'space-between' }}>
          <span>{wallet.isReal ? 'wallet' : 'demo account'}</span>
          <span className="mono">{truncHash(wallet.activeKey ?? '')}</span>
        </div>
      )}
    </section>
  );
}
