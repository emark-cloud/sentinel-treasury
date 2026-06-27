/**
 * Loop controller — drives the perceive→decide→act→prove choreography (design.md §7).
 *
 * Production posture: the center column animates from the **autonomous runner's real cycles**. On
 * mount it loads the runner's recent cycles + liveness status and subscribes to the live SSE feed;
 * each real cycle the agent completes plays through the same stepper → debate → deploy-hash →
 * receipt choreography. When no runner is configured (`live:false`, a fresh checkout) it falls back
 * to a client-side demo source, and the `inject()` demo trigger stays available either way (now a
 * secondary control, clearly tagged — spec §15.3).
 *
 * Motion discipline is unchanged: the stepper advances stage by stage, the debate streams turn by
 * turn, and the deploy_hash + receipt badge are the two punctuation moments. Pause is an immediate
 * lock — the agent cannot inject/act while paused.
 */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AllocationBps, CycleView, Regime, RunnerStatus } from '@sentinel/shared';
import { ScenarioSource } from './scenario';
import { cycleViewToCycle } from './liveCycle';
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
  /** True once the runner backend is the cycle source (else the demo fallback is driving). */
  live: boolean;
  /** Runner liveness + schedule (null until loaded / when no runner is configured). */
  runner: RunnerStatus | null;
}

/** Initial loop state: a resting 60/40 book plus a short, fully-verifiable demo audit trail. */
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
    live: false,
    runner: null,
  };
}

/** Derive the resting left-rail figures from a real cycle history (newest first). */
function deriveFromHistory(cycles: Cycle[]): Partial<LoopState> {
  const latest = cycles[0];
  if (!latest) return {};
  const dayAgo = Date.now() - 24 * 3600e3;
  const today = cycles.filter((c) => c.startedAt >= dayAgo);
  const paid = cycles.filter((c) => c.x402Spend.settleTx);
  return {
    alloc: latest.postAllocBps,
    regime: latest.regime,
    targetBps: latest.targetBps,
    twapUsd: latest.snapshot.csprUsdTwap,
    daySpentUsd: today.reduce((sum, c) => sum + Number(c.notionalUsd), 0),
    x402: {
      paidPulls: paid.length,
      csprSpent: Number(paid.reduce((sum, c) => sum + c.x402Spend.amountCspr, 0).toFixed(1)),
      lastSettleTx: paid[0]?.x402Spend.settleTx ?? null,
    },
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
  const seenIds = useRef<Set<string>>(new Set());
  const queue = useRef<Cycle[]>([]);
  // Control-flow mirrors of running/paused so `drain` can gate without an impure setState updater.
  const runningRef = useRef(false);
  const pausedRef = useRef(false);

  const [state, setState] = useState<LoopState>(() => buildInitial(sourceRef.current!));

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const at = (delay: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, delay));
  };
  const patch = (p: Partial<LoopState>) => setState((s) => ({ ...s, ...p }));

  // The shared choreography: animate one fully-resolved cycle (live or demo) through the stepper.
  const play = useCallback(
    (cycle: Cycle) => {
      const paidPull = !!cycle.x402Spend.settleTx;
      const entries = 2 + cycle.decision.transcript.length; // Scout + Risk verdict + each turn

      runningRef.current = true;
      clearTimers();

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

      at(T.toDecide, () => patch({ stage: 'decide', revealedTurns: 2 }));
      let t = T.toDecide;
      for (let i = 3; i <= entries; i++) {
        t += T.turnGap;
        const n = i;
        at(t, () => patch({ revealedTurns: n }));
      }
      t += T.toConsensus;
      at(t, () => patch({ consensus: true }));

      t += T.toAct;
      at(t, () => patch({ stage: 'act', execStatus: 'building' }));
      t += T.signing;
      at(t, () => patch({ execStatus: 'signing' }));
      t += T.submitted;
      at(t, () => patch({ execStatus: 'submitted', showDeployHash: true }));
      t += T.finalized;
      at(t, () => patch({ execStatus: 'finalized' }));

      t += T.toProve;
      at(t, () => patch({ stage: 'prove' }));
      t += T.receipt;
      at(t, () =>
        setState((cur) => ({
          ...cur,
          alloc: cycle.postAllocBps,
          daySpentUsd: cur.daySpentUsd + Number(cycle.notionalUsd),
          history: [cycle, ...cur.history.filter((c) => c.id !== cycle.id)],
          freshReceiptId: cycle.id,
        })),
      );
      t += T.toIdle;
      at(t, () => {
        runningRef.current = false;
        patch({ stage: 'idle', running: false });
        drain();
      });

      setState((s) => ({
        ...s,
        running: true,
        cycle,
        revealedTurns: 0,
        consensus: false,
        execStatus: 'idle',
        showDeployHash: false,
        stage: 'perceive',
        targetBps: cycle.targetBps,
        x402: paidPull
          ? {
              paidPulls: s.x402.paidPulls + 1,
              csprSpent: Number((s.x402.csprSpent + cycle.x402Spend.amountCspr).toFixed(1)),
              lastSettleTx: cycle.x402Spend.settleTx,
            }
          : s.x402,
      }));
    },
    [clearTimers],
  );

  // Play the next queued cycle when idle; live SSE arrivals queue here so they never overlap.
  const drain = useCallback(() => {
    if (runningRef.current || pausedRef.current) return;
    const next = queue.current.shift();
    if (next) play(next);
  }, [play]);

  const enqueue = useCallback(
    (cycle: Cycle) => {
      if (seenIds.current.has(cycle.id)) return;
      seenIds.current.add(cycle.id);
      queue.current.push(cycle);
      drain();
    },
    [drain],
  );

  // --- live feed: load recent cycles + status, then subscribe to the SSE stream. ---
  const loadLive = useCallback(async () => {
    try {
      const [cyclesRes, statusRes] = await Promise.all([
        fetch('/api/cycles?limit=20', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/status', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      const runner: RunnerStatus | null = statusRes?.status ?? null;
      const views: CycleView[] = cyclesRes?.live ? (cyclesRes.cycles ?? []) : [];
      if (views.length === 0) {
        // No real cycles yet — keep the demo fallback, but reflect runner liveness if present.
        if (cyclesRes?.live) patch({ live: true, runner });
        return;
      }
      const cycles = views.map(cycleViewToCycle); // newest first (runner returns newest first)
      for (const c of cycles) seenIds.current.add(c.id);
      setState((s) => ({
        ...s,
        live: true,
        runner,
        history: cycles,
        freshReceiptId: null,
        ...deriveFromHistory(cycles),
      }));
    } catch {
      // Runner unreachable — stay on the demo fallback.
    }
  }, []);

  useEffect(() => {
    void loadLive();
    const es = new EventSource('/api/cycles/stream');
    es.onmessage = (e) => {
      try {
        const view = JSON.parse(e.data) as CycleView;
        if (!view?.id) return;
        patch({ live: true });
        enqueue(cycleViewToCycle(view));
      } catch {
        // ignore malformed frames / keep-alive comments
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
    return () => {
      es.close();
      clearTimers();
    };
  }, [loadLive, enqueue, clearTimers]);

  // Demo injection (secondary trigger) — queues a labelled client-side cycle (live:false), through
  // the same play/queue path as real cycles so it never overlaps a running deliberation.
  const inject = useCallback(
    (scenario: ScenarioKind) => {
      enqueue(sourceRef.current!.next(scenario));
    },
    [enqueue],
  );

  const togglePause = useCallback(() => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setState((s) => ({ ...s, paused: next }));
    if (!next) drain(); // unpausing may release a queued cycle
  }, [drain]);

  const reset = useCallback(() => {
    clearTimers();
    runningRef.current = false;
    queue.current = [];
    seenIds.current = new Set();
    sourceRef.current = new ScenarioSource();
    setState(buildInitial(sourceRef.current));
    void loadLive();
  }, [clearTimers, loadLive]);

  return { ...state, inject, togglePause, reset };
}
