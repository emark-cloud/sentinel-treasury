import { describe, it, expect } from 'vitest';
import type { ChainClient, TxStatus } from '../src/execution/chainClient.js';
import type { TxSigner } from '../src/execution/signer.js';
import type { Clock } from '../src/execution/executionService.js';
import type { SwapRoutes } from '../src/execution/transaction.js';
import { ExecutionService } from '../src/execution/executionService.js';
import { MemoryCycleStore } from '../src/execution/cycleStore.js';
import { CircuitBreaker } from '../src/execution/circuitBreaker.js';
import { MemoryArtifactStore } from '../src/store/artifactStore.js';
import { ScriptedLlmClient } from '../src/llm/types.js';
import { RiskAgent } from '../src/agents/risk.js';
import { TreasuryAgent } from '../src/agents/treasury.js';
import { Deliberator, DecisionEngine } from '../src/decision/deliberate.js';
import { Scout } from '../src/agents/scout.js';
import type { DecisionInputs, DecisionPolicy } from '../src/decision/types.js';
import { SentinelLoop } from '../src/loop.js';
import type { SentinelLoopDeps, SentinelLoopConfig } from '../src/loop.js';
import { buildScenario, demoBalances } from '../src/scenario/scenarios.js';
import type { ScenarioKind } from '../src/scenario/scenarios.js';
import type { VaultBalances } from '@sentinel/shared';

const AGENT_PK = '01a4e9a55d4546c2e3d11643b6cdf3192a4c6db36b987704afd6e0d88009309fd6';
const h32 = (b: string) => b.repeat(32);

const routes: SwapRoutes = {
  swapToStable: [h32('aa'), h32('bb'), h32('cc')],
  swapToRisk: [h32('cc'), h32('bb'), h32('aa')],
};

const POLICY: DecisionPolicy = {
  perActionCapUsd: 250,
  dailyCapUsd: 1000,
  dayRemainingUsd: 1000,
  maxSlippageBps: 100,
  minScsprBps: 1000,
  maxScsprBps: 7000,
  csprBufferCspr: 75,
  minTradeUsd: 1,
};

const TARGETS = { router: h32('cc'), staking: h32('dd') };

class FakeChain implements ChainClient {
  submitted = 0;
  nextHash = h32('de');
  statuses = new Map<string, TxStatus>();
  constructor(success = true) {
    this.statuses.set(this.nextHash, { finalized: true, success });
  }
  submit(): Promise<string> {
    this.submitted += 1;
    return Promise.resolve(this.nextHash);
  }
  getStatus(txHash: string): Promise<TxStatus | null> {
    return Promise.resolve(this.statuses.get(txHash) ?? null);
  }
  getDictionaryBytes(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }
}

const signer: TxSigner = { publicKeyHex: AGENT_PK, sign: () => {} };

function fakeClock(): Clock {
  let t = 1000;
  return { now: () => t, sleep: (ms) => ((t += ms), Promise.resolve()) };
}

/** Assemble a loop with the §15.3 scenario sources + a deterministic (fallback) decision path. */
function makeLoop(
  kind: ScenarioKind,
  balances: VaultBalances,
  chain = new FakeChain(),
): {
  loop: SentinelLoop;
  chain: FakeChain;
  breaker: CircuitBreaker;
  scn: ReturnType<typeof buildScenario>;
} {
  const scn = buildScenario(kind, { balances, nowSec: 1_000_000 });
  const store = new MemoryArtifactStore();
  // Empty LLM queue → every agent turn falls back to the deterministic rule engine (no network).
  const llm = new ScriptedLlmClient([]);
  const deliberator = new Deliberator(new RiskAgent(llm, POLICY), new TreasuryAgent(llm), POLICY);
  const decisionEngine = new DecisionEngine(deliberator, store);
  const cycleStore = new MemoryCycleStore();
  const execution = new ExecutionService(
    chain,
    signer,
    cycleStore,
    {
      chainName: 'casper-test',
      vaultPackageHash: h32('11'),
      routes,
      paymentMotes: 20_000_000_000,
      pollIntervalMs: 10,
      pollTimeoutMs: 30,
    },
    fakeClock(),
  );
  const breaker = new CircuitBreaker({ maxConsecutiveReverts: 3 });

  const deps: SentinelLoopDeps = {
    sources: scn.sources,
    scout: new Scout(store),
    decisionEngine,
    execution,
    circuitBreaker: breaker,
    store,
  };
  const decisionInputs: DecisionInputs = {
    exchangeRate: 1.052,
    policy: POLICY,
    targets: TARGETS,
  };
  const cfg: SentinelLoopConfig = {
    decisionInputs,
    oracleGuard: { maxHeartbeatAgeSec: 5400, maxDivergenceBps: 500 },
  };
  return { loop: new SentinelLoop(deps, cfg), chain, breaker, scn };
}

describe('SentinelLoop end-to-end', () => {
  it('price-shock from 60/40 → Stressed → capped de-risk swap, finalized on-chain', async () => {
    const balances = demoBalances({ scsprBps: 6000, twapUsd: 0.0304 });
    const { loop, chain, scn } = makeLoop('price-shock', balances);
    const res = await loop.runCycle({
      cycleId: 'cyc-shock',
      premium: scn.premium,
      volatility: scn.volatility,
      now: 1_000_000_000,
    });

    expect(res.stage).toBe('acted');
    expect(res.regime).toBe('Stressed');
    expect(res.decision!.decision.finalAction.kind).toBe('SwapToStable');
    // Single capped corrective action — notional ≤ per-action cap.
    expect(res.decision!.sized.sizeUsd).toBeLessThanOrEqual(POLICY.perActionCapUsd);
    expect(res.execution!.result).toBe('Success');
    expect(res.execution!.deployHash).toBe(h32('de'));
    expect(res.acted).toBe(true);
    expect(chain.submitted).toBe(1);
    expect(res.circuit!.tripped).toBe(false);
  });

  it('calm from a de-risked 20/80 → Calm → grows back toward target', async () => {
    const balances = demoBalances({ scsprBps: 2000, twapUsd: 0.0307 });
    const { loop, scn } = makeLoop('calm', balances);
    const res = await loop.runCycle({
      cycleId: 'cyc-calm',
      premium: scn.premium,
      volatility: scn.volatility,
      now: 1_000_000_000,
    });

    expect(res.regime).toBe('Calm');
    // No liquid CSPR beyond the buffer → grow via stable→risk swap.
    expect(res.decision!.decision.finalAction.kind).toBe('SwapToRisk');
    expect(res.acted).toBe(true);
  });

  it('oracle divergence rejects the cycle before it acts (no tx)', async () => {
    const balances = demoBalances({ scsprBps: 6000 });
    const { loop, chain } = makeLoop('oracle-divergence', balances);
    const res = await loop.runCycle({ cycleId: 'cyc-oracle', now: 1_000_000_000 });

    expect(res.stage).toBe('guarded');
    expect(res.acted).toBe(false);
    expect(res.reason).toMatch(/divergence/);
    expect(res.execution).toBeUndefined();
    expect(chain.submitted).toBe(0);
  });

  it('paused: perceives nothing, submits nothing', async () => {
    const balances = demoBalances({ scsprBps: 6000 });
    const { loop, chain } = makeLoop('price-shock', balances);
    const res = await loop.runCycle({ cycleId: 'cyc-paused', paused: true, now: 1_000_000_000 });

    expect(res.stage).toBe('paused');
    expect(res.acted).toBe(false);
    expect(chain.submitted).toBe(0);
  });

  it('already at target → NoOp, no on-chain action', async () => {
    // Calm regime already at the 60/40 calm target → nothing to correct.
    const balances = demoBalances({ scsprBps: 6000, twapUsd: 0.0307 });
    const { loop, chain } = makeLoop('calm', balances);
    const res = await loop.runCycle({ cycleId: 'cyc-noop', now: 1_000_000_000 });

    expect(res.decision!.decision.finalAction.kind).toBe('NoOp');
    expect(res.execution!.result).toBe('Skipped');
    expect(res.acted).toBe(false);
    expect(chain.submitted).toBe(0);
  });

  it('a tripped breaker blocks subsequent cycles', async () => {
    const balances = demoBalances({ scsprBps: 6000, twapUsd: 0.0304 });
    const { loop, breaker } = makeLoop('price-shock', balances);
    breaker.record('Reverted');
    breaker.record('Reverted');
    breaker.record('Reverted'); // trips at maxConsecutiveReverts=3
    expect(breaker.isTripped).toBe(true);

    const res = await loop.runCycle({ cycleId: 'cyc-after-trip', now: 1_000_000_000 });
    expect(res.stage).toBe('paused');
    expect(res.reason).toMatch(/circuit breaker/);
  });
});
