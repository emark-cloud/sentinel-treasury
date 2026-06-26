/** Action card (design.md §5.5) — the TransactionV1 signing/submitting; live deploy_hash. */
'use client';
import type { Cycle, ExecStatus } from '../../lib/types';
import { HashChip } from '../atoms';
import { deployUrl } from '../../lib/chain';
import { fmtAmount } from '../../lib/format';

const STEPS: { key: ExecStatus; label: string }[] = [
  { key: 'building', label: 'Building TransactionV1' },
  { key: 'signing', label: 'Signing (bounded agent key)' },
  { key: 'submitted', label: 'Submitted to Testnet' },
  { key: 'finalized', label: 'Finalized' },
];

const ORDER: ExecStatus[] = ['idle', 'building', 'signing', 'submitted', 'finalized'];

export function ActionCard({
  cycle,
  execStatus,
  showDeployHash,
}: {
  cycle: Cycle | null;
  execStatus: ExecStatus;
  showDeployHash: boolean;
}) {
  const active = execStatus !== 'idle';
  const curIdx = ORDER.indexOf(execStatus);
  const reverted = execStatus === 'reverted';

  return (
    <section
      className="card"
      style={{
        opacity: cycle && active ? 1 : 0.5,
        borderColor: reverted ? 'var(--coral-line)' : undefined,
      }}
    >
      <h3 className="card-title">
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          Action
          <span className="label">execute_rebalance</span>
        </span>
        {cycle && active && (
          <span
            className={execStatus === 'finalized' ? 'pill tone-green' : 'pill tone-info'}
            style={{ fontSize: 10 }}
          >
            {execStatus}
          </span>
        )}
      </h3>

      {!cycle || !active ? (
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-faint)',
            textAlign: 'center',
            padding: '24px 0',
          }}
        >
          No transaction in flight
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 12 }}>
            <div>
              <div className="label">Entry point</div>
              <div className="mono" style={{ fontSize: 12 }}>
                execute_rebalance · {cycle.decision.finalAction.kind}
              </div>
            </div>
            <div>
              <div className="label">Amount</div>
              <div className="mono" style={{ fontSize: 12 }}>
                {fmtAmount(cycle.decision.finalAction.amount, cycle.decision.finalAction.asset)}
              </div>
            </div>
            <div>
              <div className="label">Target (whitelisted)</div>
              <HashChip hash={cycle.decision.finalAction.target} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {STEPS.map((step) => {
              const idx = ORDER.indexOf(step.key);
              const done = curIdx > idx;
              const now = curIdx === idx;
              const color = done ? 'var(--green)' : now ? 'var(--info)' : 'var(--text-faint)';
              return (
                <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    className={now ? 'dot pulse' : 'dot'}
                    style={{ color, width: 7, height: 7 }}
                  />
                  <span
                    className={now ? 'ticking' : ''}
                    style={{
                      fontSize: 12,
                      color: now || done ? 'var(--text)' : 'var(--text-faint)',
                    }}
                  >
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 14,
              padding: 12,
              border: `1px solid ${showDeployHash ? 'var(--green-line)' : 'var(--border)'}`,
              borderRadius: 'var(--r-ctl)',
              background: showDeployHash ? 'var(--green-dim)' : 'var(--surface-2)',
              transition: 'all 0.3s ease',
            }}
          >
            <div className="label" style={{ marginBottom: 6 }}>
              deploy_hash
            </div>
            {showDeployHash ? (
              <span className="snap-in" style={{ display: 'inline-block' }}>
                <HashChip hash={cycle.deployHash} href={deployUrl(cycle.deployHash)} />
              </span>
            ) : (
              <span className="mono ticking" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                awaiting submission…
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
