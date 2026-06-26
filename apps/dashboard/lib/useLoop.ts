/**
 * Loop controller — drives the perceive→decide→act→prove choreography (design.md §7).
 *
 * Motion discipline: the stepper advances stage by stage and the debate streams turn by
 * turn; the deploy_hash and the receipt badge are the two punctuation moments. Everything
 * else is static. Pause is an immediate lock — the agent cannot inject/act while paused.
 */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AllocationBps, Regime } from '@sentinel/shared';
import { ScenarioSource } from './scenario';
import type { Cycle, ExecStatus, LoopStage, ScenarioKind, X402State } from './types';

export interface LoopState {
  stage: LoopStage;
  running: boolean;
  paused: boolean;
  cycle: Cycle | null;
  revealedTurns: number;
  consensus: boolean;
  execStatus: ExecStatus;
  showDeployHash: boolean;
  alloc: AllocationBps;
  targetBps: { scspr: number; csprusd: number };
  regime: Regime; // resting regime (last classified) — drives the allocation pill
  twapUsd: number; // CSPR/USD TWAP shown in the allocation card
  managedUsd: number; // total USD across the two managed buckets (excludes buffer)
  daySpentUsd: number; // USD micros
  x402: X402State;
  history: Cycle[]; // newest first — the receipt feed + verify artifacts
  freshReceiptId: string | null; // drives the snap-in animation
}

/** Initial loop state: a resting 60/40 book plus a short, fully-verifiable audit trail. */
function buildInitial(source: ScenarioSource): LoopState {
  const history = source.seed([
    { scenario: 'calm', agoMs: 2.4 * 3600e3 },
    { scenario: 'shock', agoMs: 2.0 * 3600e3 },
    { scenario: 'calm', agoMs: 47 * 60e3 },
  ]);
  const rest = source.restingView();
  const daySpentUsd = history.reduce((sum, c) => sum + Number(c.notionalUsd), 0);
  return {
    stage: 'idle',
    running: false,
    paused: false,
    cycle: null,
    revealedTurns: 0,
    consensus: false,
    execStatus: 'idle',
    showDeployHash: false,
    alloc: rest.alloc,
    targetBps: { scspr: rest.regime === 'Calm' ? 6000 : 2000, csprusd: rest.regime === 'Calm' ? 4000 : 8000 },
    regime: rest.regime,
    twapUsd: rest.twapUsd,
    managedUsd: rest.managedUsd,
    daySpentUsd,
    x402: { paidPulls: history.length, csprSpent: Number((history.length * 0.7).toFixed(1)), lastSettleTx: history[0]?.x402Spend.settleTx ?? null },
    history,
    freshReceiptId: null,
  };
}

export interface LoopApi extends LoopState {
  inject: (scenario: ScenarioKind) => void;
  togglePause: () => void;
  reset: () => void;
}

// Choreography timings (ms).
const T = {
  toDecide: 900,
  turnGap: 1100,
  toConsensus: 800,
  toAct: 700,
  signing: 750,
  submitted: 900,
  finalized: 1300,
  toProve: 700,
  receipt: 550,
  toIdle: 1400,
};

export function useLoop(): LoopApi {
  const sourceRef = useRef<ScenarioSource | undefined>(undefined);
  if (!sourceRef.current) sourceRef.current = new ScenarioSource();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [state, setState] = useState<LoopState>(() => buildInitial(sourceRef.current!));

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const at = (delay: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, delay));
  };

  const patch = (p: Partial<LoopState>) => setState((s) => ({ ...s, ...p }));

  const inject = useCallback(
    (scenario: ScenarioKind) => {
      setState((s) => {
        if (s.running || s.paused) return s;
        const cycle = sourceRef.current!.next(scenario);
        // Debate entries: Scout (perception) + Risk verdict + each transcript turn.
        const entries = 2 + cycle.decision.transcript.length;

        clearTimers();

        // PERCEIVE — snapshot assembled (Scout entry), one x402 paid pull.
        at(0, () =>
          patch({
            stage: 'perceive',
            consensus: false,
            execStatus: 'idle',
            showDeployHash: false,
            revealedTurns: 1,
            targetBps: cycle.targetBps,
            regime: cycle.regime,
            twapUsd: cycle.snapshot.csprUsdTwap,
          }),
        );

        // DECIDE — stream the debate entry by entry (Risk verdict → Treasury → Risk approve).
        at(T.toDecide, () => patch({ stage: 'decide', revealedTurns: 2 }));
        let t = T.toDecide;
        for (let i = 3; i <= entries; i++) {
          t += T.turnGap;
          const n = i;
          at(t, () => patch({ revealedTurns: n }));
        }
        t += T.toConsensus;
        at(t, () => patch({ consensus: true }));

        // ACT — build → sign → submit (deploy_hash) → finalize.
        t += T.toAct;
        at(t, () => patch({ stage: 'act', execStatus: 'building' }));
        t += T.signing;
        at(t, () => patch({ execStatus: 'signing' }));
        t += T.submitted;
        at(t, () => patch({ execStatus: 'submitted', showDeployHash: true }));
        t += T.finalized;
        at(t, () => patch({ execStatus: 'finalized' }));

        // PROVE — receipt snaps into the feed; allocation settles to post.
        t += T.toProve;
        at(t, () => patch({ stage: 'prove' }));
        t += T.receipt;
        at(t, () =>
          setState((cur) => ({
            ...cur,
            alloc: cycle.postAllocBps,
            managedUsd: sourceRef.current!.restingView().managedUsd,
            daySpentUsd: cur.daySpentUsd + Number(cycle.notionalUsd),
            history: [cycle, ...cur.history],
            freshReceiptId: cycle.id,
          })),
        );
        t += T.toIdle;
        at(t, () => patch({ stage: 'idle', running: false }));

        return {
          ...s,
          running: true,
          cycle,
          revealedTurns: 0,
          consensus: false,
          execStatus: 'idle',
          showDeployHash: false,
          stage: 'perceive',
          targetBps: cycle.targetBps,
          x402: {
            paidPulls: s.x402.paidPulls + 1,
            csprSpent: s.x402.csprSpent + cycle.x402Spend.amountCspr,
            lastSettleTx: cycle.x402Spend.settleTx,
          },
        };
      });
    },
    [clearTimers],
  );

  const togglePause = useCallback(() => {
    setState((s) => ({ ...s, paused: !s.paused }));
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    sourceRef.current = new ScenarioSource();
    setState(buildInitial(sourceRef.current));
  }, [clearTimers]);

  return { ...state, inject, togglePause, reset };
}
