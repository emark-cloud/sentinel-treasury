/**
 * Risk agent (spec §6.1) — classifies the market regime, quantifies risk, and sets the per-cycle
 * hard ceilings the Treasury proposal is held to. Reasons over the `MarketSnapshot` only.
 *
 * Gemini Flash, structured JSON, parse-validate-retry (one repair) → deterministic fallback
 * (`deterministicVerdict`). The verdict is always sanitized into the policy/regime envelope so a
 * hallucinated ceiling can never widen the agent's reach.
 */
import type { MarketSnapshot, RiskVerdict } from '@sentinel/shared';
import type { LlmClient, ResponseSchema } from '../llm/types.js';
import { generateValidated } from '../llm/types.js';
import { deterministicVerdict, REGIME_BANDS } from '../decision/ruleEngine.js';
import type { DecisionPolicy } from '../decision/types.js';

const RISK_SYSTEM = [
  'You are the Risk agent for an autonomous on-chain treasury.',
  'Classify the market regime (Calm | Elevated | Stressed), quantify a 0..100 risk score, list the',
  'concrete drivers, and impose hard ceilings for this cycle (max sCSPR weight in bps, max action',
  'notional in USD). You have veto power but you do not propose allocations.',
  'Respond with JSON only, matching the provided schema. No prose outside the JSON.',
].join(' ');

/** Gemini `responseSchema` (OpenAPI subset) mirroring `riskVerdictSchema`. */
const RISK_RESPONSE_SCHEMA: ResponseSchema = {
  type: 'object',
  properties: {
    regime: { type: 'string', enum: ['Calm', 'Elevated', 'Stressed'] },
    riskScore: { type: 'number' },
    drivers: { type: 'array', items: { type: 'string' } },
    hardLimits: {
      type: 'object',
      properties: {
        maxScsprBps: { type: 'integer' },
        maxActionUsd: { type: 'number' },
      },
      required: ['maxScsprBps', 'maxActionUsd'],
    },
    rationale: { type: 'string' },
  },
  required: ['regime', 'riskScore', 'drivers', 'hardLimits', 'rationale'],
};

export interface RiskAssessment {
  verdict: RiskVerdict;
  source: 'llm' | 'fallback';
}

export class RiskAgent {
  constructor(
    private readonly llm: LlmClient,
    private readonly policy: DecisionPolicy,
  ) {}

  /** Build the user-turn prompt from the snapshot (compact, machine-friendly). */
  private prompt(snap: MarketSnapshot): string {
    const facts = {
      csprUsdTwap: snap.csprUsdTwap,
      csprUsdSpot: snap.csprUsdSpot,
      twapSpotDivergenceBps: snap.twapSpotDivergenceBps,
      volatility: snap.volatility,
      depthUsd: snap.liquidity.csprUsdPool.depthUsd,
      premiumRiskIndex: snap.premiumSignal?.riskIndex ?? null,
    };
    return [
      'Market snapshot:',
      JSON.stringify(facts),
      `Policy bounds: minScsprBps=${this.policy.minScsprBps}, maxScsprBps=${this.policy.maxScsprBps},`,
      `perActionCapUsd=${this.policy.perActionCapUsd}.`,
      'maxScsprBps must not exceed the policy bound; maxActionUsd must not exceed perActionCapUsd.',
    ].join(' ');
  }

  /**
   * Sanitize an LLM verdict back into the legal envelope: clamp the risk score, cap `maxScsprBps`
   * at the regime band max and the policy bound, and cap `maxActionUsd` at the per-action cap.
   */
  private sanitize(v: RiskVerdict): RiskVerdict {
    const bandMax = REGIME_BANDS[v.regime].maxScsprBps;
    return {
      ...v,
      riskScore: Math.max(0, Math.min(100, v.riskScore)),
      hardLimits: {
        maxScsprBps: Math.max(
          0,
          Math.min(v.hardLimits.maxScsprBps, bandMax, this.policy.maxScsprBps),
        ),
        maxActionUsd: Math.max(0, Math.min(v.hardLimits.maxActionUsd, this.policy.perActionCapUsd)),
      },
    };
  }

  async assess(snap: MarketSnapshot): Promise<RiskAssessment> {
    const llmVerdict = await generateValidated<RiskVerdict>(this.llm, 'riskVerdict', {
      system: RISK_SYSTEM,
      prompt: this.prompt(snap),
      responseSchema: RISK_RESPONSE_SCHEMA,
      temperature: 0,
    });
    if (llmVerdict) return { verdict: this.sanitize(llmVerdict), source: 'llm' };
    return { verdict: deterministicVerdict(snap, this.policy), source: 'fallback' };
  }
}
