import { describe, it, expect } from 'vitest';
import { hashCanonical, validate } from '@sentinel/shared';
import type { MarketSnapshot, RiskVerdict, AllocationProposal, Decision } from '@sentinel/shared';
import { ScriptedLlmClient } from '../src/llm/types.js';
import { RiskAgent } from '../src/agents/risk.js';
import { TreasuryAgent } from '../src/agents/treasury.js';
import { Deliberator, DecisionEngine } from '../src/decision/deliberate.js';
import { MemoryArtifactStore } from '../src/store/artifactStore.js';
import type { DecisionInputs, DecisionPolicy } from '../src/decision/types.js';

const policy: DecisionPolicy = {
  perActionCapUsd: 1000,
  dailyCapUsd: 5000,
  dayRemainingUsd: 5000,
  maxSlippageBps: 100,
  minScsprBps: 0,
  maxScsprBps: 10000,
  csprBufferCspr: 0,
  minTradeUsd: 1,
};

const decisionInputs: DecisionInputs = {
  exchangeRate: 1.0,
  policy,
  targets: { router: 'router-hash', staking: 'staking-hash' },
};

function snap(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    timestamp: 1_700_000_000_000,
    csprUsdTwap: 1,
    csprUsdSpot: 1,
    twapSpotDivergenceBps: 0,
    volatility: { window: '24h', annualizedPct: 0 },
    liquidity: { csprUsdPool: { depthUsd: 100000 }, priceImpactCurve: [] },
    // 80% sCSPR / 20% stable, total $1000 — skewed risk-on so a de-risk action is available.
    vault: { cspr: '0', scspr: '800000000000', csprusd: '200000000' },
    provenance: [],
    ...overrides,
  };
}

function verdict(overrides: Partial<RiskVerdict> = {}): RiskVerdict {
  return {
    regime: 'Stressed',
    riskScore: 80,
    drivers: ['twap-spot divergence 5.00%'],
    hardLimits: { maxScsprBps: 3000, maxActionUsd: 1000 },
    rationale: 'stressed',
    ...overrides,
  };
}

function proposal(scspr: number): AllocationProposal {
  return {
    targetBps: { scspr, csprusd: 10000 - scspr, csprBuffer: 0 },
    action: { kind: 'NoOp', asset: 'CSPR', amount: '0', target: '' },
    expectedSlippageBps: 30,
    rationale: `target ${scspr} bps sCSPR`,
  };
}

describe('RiskAgent', () => {
  it('uses a valid LLM verdict (sanitized into the envelope)', async () => {
    const llm = new ScriptedLlmClient([
      verdict({ hardLimits: { maxScsprBps: 9999, maxActionUsd: 1e9 } }),
    ]);
    const agent = new RiskAgent(llm, policy);
    const { verdict: v, source } = await agent.assess(snap());
    expect(source).toBe('llm');
    // sanitize caps maxScsprBps at the Stressed band (3000) and maxActionUsd at perActionCap.
    expect(v.hardLimits.maxScsprBps).toBeLessThanOrEqual(3000);
    expect(v.hardLimits.maxActionUsd).toBe(policy.perActionCapUsd);
  });

  it('falls back deterministically when the LLM output is invalid', async () => {
    const llm = new ScriptedLlmClient([{}, {}]); // initial + repair both invalid
    const agent = new RiskAgent(llm, policy);
    const { source } = await agent.assess(snap({ twapSpotDivergenceBps: 1000 }));
    expect(source).toBe('fallback');
  });
});

describe('TreasuryAgent', () => {
  it('falls back to the regime allocation when the LLM fails', async () => {
    const llm = new ScriptedLlmClient([{}, {}]);
    const agent = new TreasuryAgent(llm);
    const { proposal: p, source } = await agent.propose({
      snapshot: snap(),
      verdict: verdict(),
      round: 1,
    });
    expect(source).toBe('fallback');
    expect(p.targetBps.scspr).toBe(2000); // Stressed fallback
  });
});

describe('Deliberator', () => {
  it('reaches consensus on a within-band first proposal', async () => {
    const risk = new RiskAgent(new ScriptedLlmClient([verdict()]), policy);
    const treasury = new TreasuryAgent(new ScriptedLlmClient([proposal(2000)]));
    const out = await new Deliberator(risk, treasury, policy).deliberate(snap());
    expect(out.consensus).toBe(true);
    expect(out.source).toBe('llm');
    expect(out.transcript.map((t) => t.kind)).toEqual(['propose', 'approve']);
  });

  it('rejects then accepts a revised proposal', async () => {
    const risk = new RiskAgent(new ScriptedLlmClient([verdict()]), policy);
    // round 1 out-of-band (9000) → reject; round 2 in-band (2000) → approve.
    const treasury = new TreasuryAgent(new ScriptedLlmClient([proposal(9000), proposal(2000)]));
    const out = await new Deliberator(risk, treasury, policy).deliberate(snap());
    expect(out.consensus).toBe(true);
    expect(out.transcript.map((t) => t.kind)).toEqual(['propose', 'reject', 'revise', 'approve']);
    const reject = out.transcript.find((t) => t.kind === 'reject');
    expect(reject?.reasons?.length).toBeGreaterThan(0);
  });

  it('falls back when no consensus within R rounds', async () => {
    const risk = new RiskAgent(new ScriptedLlmClient([verdict()]), policy);
    const treasury = new TreasuryAgent(new ScriptedLlmClient([proposal(9000)]));
    const out = await new Deliberator(risk, treasury, policy, { maxRounds: 1 }).deliberate(snap());
    expect(out.consensus).toBe(false);
    expect(out.source).toBe('fallback');
    expect(out.targetBps.scspr).toBe(2000); // Stressed fallback allocation
  });

  it('flags consensus on a deterministic proposal as fallback source', async () => {
    const risk = new RiskAgent(new ScriptedLlmClient([verdict()]), policy);
    // Treasury LLM down → fallback proposal (Stressed 2000) which the critic approves.
    const treasury = new TreasuryAgent(new ScriptedLlmClient([{}, {}]));
    const out = await new Deliberator(risk, treasury, policy).deliberate(snap());
    expect(out.consensus).toBe(true);
    expect(out.source).toBe('fallback');
  });
});

describe('DecisionEngine', () => {
  it('produces a schema-valid Decision whose hash matches the stored artifact', async () => {
    const store = new MemoryArtifactStore();
    const risk = new RiskAgent(new ScriptedLlmClient([verdict()]), policy);
    const treasury = new TreasuryAgent(new ScriptedLlmClient([proposal(2000)]));
    const engine = new DecisionEngine(new Deliberator(risk, treasury, policy), store);

    const snapshot = snap();
    const perceptionHash = hashCanonical(snapshot);
    const { decision, decisionHash, sized } = await engine.decide(
      'cycle-1',
      snapshot,
      perceptionHash,
      decisionInputs,
    );

    expect(validate<Decision>('decision', decision).valid).toBe(true);
    expect(decision.snapshotHash).toBe(perceptionHash);
    expect(decisionHash).toBe(hashCanonical(decision));
    expect(decision.consensus).toBe(true);
    // Stressed target (20% sCSPR) on an 80%-sCSPR vault ⇒ de-risk swap.
    expect(decision.finalAction.kind).toBe('SwapToStable');
    expect(sized.sizeUsd).toBeGreaterThan(0);

    const stored = await store.getByHash<Decision>(decisionHash);
    expect(stored?.cycleId).toBe('cycle-1');
    expect(hashCanonical(stored?.artifact)).toBe(decisionHash);
  });

  it('clamps a runaway target and still NoOps when already on target', async () => {
    const store = new MemoryArtifactStore();
    const risk = new RiskAgent(
      new ScriptedLlmClient([
        verdict({ regime: 'Calm', hardLimits: { maxScsprBps: 7000, maxActionUsd: 1000 } }),
      ]),
      policy,
    );
    const treasury = new TreasuryAgent(new ScriptedLlmClient([proposal(6000)]));
    const engine = new DecisionEngine(new Deliberator(risk, treasury, policy), store);

    // Vault already at 60/40 → Calm 6000 target ⇒ NoOp.
    const snapshot = snap({ vault: { cspr: '0', scspr: '600000000000', csprusd: '400000000' } });
    const { decision } = await engine.decide(
      'c',
      snapshot,
      hashCanonical(snapshot),
      decisionInputs,
    );
    expect(decision.finalAction.kind).toBe('NoOp');
  });
});
