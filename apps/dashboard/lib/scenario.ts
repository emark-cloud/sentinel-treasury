/**
 * Scenario data source (demo) — generates a complete perceive→decide→act→prove cycle.
 *
 * HONESTY (spec §15.3 / design.md §8): on a live deployment only the *market event* is
 * injected; the reasoning, the capped tx, the receipt are real on Testnet. This module is
 * the dashboard's demo seam: it produces realistic cycles from the real `@sentinel/shared`
 * shapes and the real canonical-JSON blake2b hashing, so the receipt-feed **verify** button
 * recomputes genuine hashes. It implements `CycleSource`; a live SSE-backed source
 * (CSPR.cloud Streaming, Phase 7) can drop in behind the same interface.
 */
import { hashCanonical } from '@sentinel/shared';
import type {
  AllocationBps,
  AllocationProposal,
  Decision,
  DeliberationTurn,
  MarketSnapshot,
  Receipt,
  Regime,
  RiskVerdict,
} from '@sentinel/shared';
import { CONTRACTS, POLICY } from './chain';
import type { Cycle, ScenarioKind } from './types';

export interface CycleSource {
  next(scenario: ScenarioKind): Cycle;
}

const SCSPR_RATE = 1.052; // CSPR per sCSPR (Wise Lending staking yield)
const BUFFER_CSPR = 75; // fixed working buffer, excluded from alloc targets
const PER_ACTION_USD = Number(POLICY.perActionCapUsd) / 1e6;

const REGIME_TARGET: Record<Regime, { scspr: number; csprusd: number }> = {
  Calm: { scspr: 6000, csprusd: 4000 },
  Elevated: { scspr: 4000, csprusd: 6000 },
  Stressed: { scspr: 2000, csprusd: 8000 },
};

function randHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(a);
  } else {
    for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Portfolio {
  scsprMotes: number; // 9-dec
  wusdtUnits: number; // 6-dec
  csprMotes: number; // 9-dec (buffer)
}

function usdValue(p: Portfolio, price: number): { scspr: number; csprusd: number; cspr: number } {
  return {
    scspr: (p.scsprMotes / 1e9) * SCSPR_RATE * price,
    csprusd: p.wusdtUnits / 1e6, // WUSDT ~ $1
    cspr: (p.csprMotes / 1e9) * price,
  };
}

function allocBps(p: Portfolio, price: number): AllocationBps {
  const v = usdValue(p, price);
  const total = v.scspr + v.csprusd + v.cspr || 1;
  const scspr = Math.round((v.scspr / total) * 10000);
  const cspr = Math.round((v.cspr / total) * 10000);
  return { scspr, cspr, csprusd: 10000 - scspr - cspr };
}

export class ScenarioSource implements CycleSource {
  // Start at a healthy calm 60/40 over a ~$10k managed book + buffer.
  private portfolio: Portfolio;
  private seq = 0;

  constructor() {
    const price = 0.0307;
    this.portfolio = {
      scsprMotes: Math.round((6000 / (price * SCSPR_RATE)) * 1e9),
      wusdtUnits: Math.round(4000 * 1e6),
      csprMotes: BUFFER_CSPR * 1e9,
    };
  }

  /** Current actual allocation (for the resting state before any cycle runs). */
  currentAllocBps(): AllocationBps {
    return allocBps(this.portfolio, 0.0307);
  }

  next(scenario: ScenarioKind): Cycle {
    this.seq += 1;
    const startedAt = Date.now();
    const cycleId = `cyc-${String(this.seq).padStart(4, '0')}`;

    const shock = scenario === 'shock';
    const regime: Regime = shock ? 'Stressed' : 'Calm';
    const price = shock ? 0.0271 : 0.0309; // shock = sharp drawdown
    const twap = shock ? 0.0304 : 0.0307; // TWAP lags spot → divergence
    const spot = price;
    const divergenceBps = Math.round((Math.abs(spot - twap) / twap) * 10000);

    const preAllocBps = allocBps(this.portfolio, twap);
    const target = REGIME_TARGET[regime];
    const v = usdValue(this.portfolio, twap);
    const managed = v.scspr + v.csprusd;

    // Single largest corrective action, capped by per-action USD cap (guardrail §11).
    const targetScsprUsd = (target.scspr / 10000) * (managed + v.cspr);
    const driftUsd = v.scspr - targetScsprUsd; // >0 ⇒ overweight sCSPR ⇒ de-risk
    const moveUsd = Math.min(Math.abs(driftUsd), PER_ACTION_USD);
    const notionalUsd = Math.round(moveUsd * 1e6).toString();

    const riskVerdict = this.buildRisk(regime, divergenceBps, shock);
    const snapshot = this.buildSnapshot(startedAt, twap, spot, divergenceBps, shock);
    const perceptionHash = hashCanonical(snapshot);

    const { proposal, postPortfolio } = this.buildAction(shock, moveUsd, twap, target);
    const postAllocBps = allocBps(postPortfolio, twap);
    this.portfolio = postPortfolio;

    const decision = this.buildDecision(regime, proposal, riskVerdict, perceptionHash);
    const decisionHash = hashCanonical(decision);

    const deployHash = randHex(32);
    const settleTx = randHex(32);

    const receipt: Receipt = {
      actionId: cycleId,
      timestamp: String(startedAt),
      agent: 'agent',
      account: 'demo-account',
      actionKind: proposal.action.kind,
      regime,
      perceptionHash,
      decisionHash,
      preAllocBps,
      postAllocBps,
      amount: proposal.action.amount,
      notionalUsd,
      target: proposal.action.target,
      deployHash,
      result: 'Success',
      csprUsdTwap: Math.round(twap * 1e5).toString(), // 5-decimal Styks scale (D-012)
    };

    return {
      id: cycleId,
      scenario,
      startedAt,
      regime,
      snapshot,
      perceptionHash,
      riskVerdict,
      proposal,
      decision,
      decisionHash,
      preAllocBps,
      postAllocBps,
      targetBps: target,
      notionalUsd,
      deployHash,
      receipt,
      x402Spend: { amountCspr: 5, settleTx },
    };
  }

  private buildSnapshot(
    timestamp: number,
    twap: number,
    spot: number,
    divergenceBps: number,
    shock: boolean,
  ): MarketSnapshot {
    return {
      timestamp,
      csprUsdTwap: twap,
      csprUsdSpot: spot,
      twapSpotDivergenceBps: divergenceBps,
      volatility: { window: '1h', annualizedPct: shock ? 142.6 : 38.2 },
      liquidity: {
        csprUsdPool: { depthUsd: shock ? 41000 : 96000 },
        priceImpactCurve: [
          { sizeUsd: 250, bps: shock ? 38 : 14 },
          { sizeUsd: 500, bps: shock ? 81 : 27 },
          { sizeUsd: 1000, bps: shock ? 173 : 55 },
        ],
      },
      premiumSignal: {
        riskIndex: shock ? 78 : 22,
        source: 'premium-x402',
        paid: { amount: '5000000000', settleTx: randHex(32) },
      },
      vault: {
        cspr: String(this.portfolio.csprMotes),
        scspr: String(this.portfolio.scsprMotes),
        csprusd: String(this.portfolio.wusdtUnits),
      },
      provenance: [
        { field: 'csprUsdTwap', label: 'VERIFIED', source: 'Styks on-chain TWAP' },
        { field: 'csprUsdSpot', label: 'VERIFIED', source: 'CSPR.trade MCP get_quote' },
        { field: 'twapSpotDivergenceBps', label: 'COMPUTED', source: '|spot-twap|/twap' },
        {
          field: 'volatility.annualizedPct',
          label: 'ESTIMATED',
          source: 'rolling 1h realized vol',
        },
        { field: 'premiumSignal.riskIndex', label: 'VERIFIED', source: 'x402 premium endpoint' },
      ],
    };
  }

  private buildRisk(regime: Regime, divergenceBps: number, shock: boolean): RiskVerdict {
    const drivers = shock
      ? [
          `twap–spot divergence ${(divergenceBps / 100).toFixed(1)}%`,
          'premium risk index 78/100',
          '1h realized vol 142%',
          'csprUSD pool depth −57%',
        ]
      : [
          `twap–spot divergence ${(divergenceBps / 100).toFixed(1)}%`,
          'premium risk index 22/100',
          'vol within band',
        ];
    return {
      regime,
      riskScore: shock ? 78 : 21,
      drivers,
      hardLimits: {
        maxScsprBps: shock ? 2500 : 7000,
        maxActionUsd: PER_ACTION_USD,
      },
      rationale: shock
        ? 'Sharp CSPR drawdown with widening TWAP–spot gap and an elevated paid risk index. ' +
          'Cap sCSPR exposure and prefer the instant DEX de-risk path over the 16h unstake queue.'
        : 'Markets within calm band; divergence and volatility nominal. Permit growth allocation ' +
          'up to the policy ceiling.',
    };
  }

  private buildAction(
    shock: boolean,
    moveUsd: number,
    twap: number,
    target: { scspr: number; csprusd: number },
  ): { proposal: AllocationProposal; postPortfolio: Portfolio } {
    const p = { ...this.portfolio };
    const expectedSlippageBps = shock ? 81 : 27;
    const minOutFactor = 1 - POLICY.maxSlippageBps / 10000;

    if (shock) {
      // De-risk: swap sCSPR → WUSDT on the router (instant path). route [sCSPR,WCSPR,WUSDT].
      const scsprMotesMoved = Math.round((moveUsd / (twap * SCSPR_RATE)) * 1e9);
      p.scsprMotes -= scsprMotesMoved;
      p.wusdtUnits += Math.round(moveUsd * 1e6);
      const minOut = Math.round(moveUsd * minOutFactor * 1e6).toString();
      return {
        postPortfolio: p,
        proposal: {
          targetBps: { scspr: target.scspr, csprusd: target.csprusd, csprBuffer: 0 },
          action: {
            kind: 'SwapToStable',
            asset: 'sCSPR',
            amount: String(scsprMotesMoved),
            target: CONTRACTS.router,
            minOut,
          },
          expectedSlippageBps,
          rationale:
            'De-risk via instant DEX swap sCSPR→WUSDT (route [sCSPR,WCSPR,WUSDT]); unstake queue ' +
            'too slow for a stress move. Sized to the per-action cap.',
        },
      };
    }

    // Calm: grow — stake CSPR→sCSPR back toward target. (Buffer untouched; stake from book.)
    const csprMotesMoved = Math.round((moveUsd / twap) * 1e9);
    p.wusdtUnits -= Math.round(moveUsd * 1e6);
    p.scsprMotes += Math.round((moveUsd / (twap * SCSPR_RATE)) * 1e9);
    return {
      postPortfolio: p,
      proposal: {
        targetBps: { scspr: target.scspr, csprusd: target.csprusd, csprBuffer: 0 },
        action: {
          kind: 'SwapToRisk',
          asset: 'csprUSD',
          amount: String(Math.round(moveUsd * 1e6)),
          target: CONTRACTS.router,
          minOut: Math.round((moveUsd / (twap * SCSPR_RATE)) * minOutFactor * 1e9).toString(),
        },
        expectedSlippageBps,
        rationale:
          'Calm regime — rotate stable back into sCSPR (route [WUSDT,WCSPR,sCSPR]) to restore the ' +
          `60/40 growth target. Sized to the per-action cap. (${csprMotesMoved >= 0 ? '' : ''}grow)`,
      },
    };
  }

  private buildDecision(
    regime: Regime,
    proposal: AllocationProposal,
    risk: RiskVerdict,
    perceptionHash: string,
  ): Decision {
    const transcript: DeliberationTurn[] = [
      {
        round: 1,
        role: 'Treasury',
        kind: 'propose',
        proposal,
        rationale: proposal.rationale,
      },
      {
        round: 1,
        role: 'Risk',
        kind: 'approve',
        rationale:
          `Within regime band and hard limits (max sCSPR ${(risk.hardLimits.maxScsprBps / 100).toFixed(0)}%, ` +
          `cap $${risk.hardLimits.maxActionUsd}). Slippage ${proposal.expectedSlippageBps}bps under ceiling. Approve.`,
      },
    ];
    return {
      consensus: true,
      source: 'llm',
      regime,
      finalAction: proposal.action,
      transcript,
      snapshotHash: perceptionHash,
    };
  }
}
