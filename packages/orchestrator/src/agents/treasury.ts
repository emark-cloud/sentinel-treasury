/**
 * Treasury agent (spec §6.1) — proposes a target allocation (bps) and a one-step action toward it,
 * given the snapshot and the Risk verdict. In a deliberation revise round it also receives the
 * Risk critic's rejection reasons and must address them.
 *
 * Gemini Flash, structured JSON, parse-validate-retry (one repair) → deterministic fallback
 * (`fallbackAllocation`). The proposed `action`/`amount` are advisory: the concrete on-chain action
 * is recomputed deterministically by the sizing module (no free-form amount reaches the chain), so
 * the proposal's job is the *target bps* and rationale.
 */
import type { MarketSnapshot, RiskVerdict, AllocationProposal } from '@sentinel/shared';
import type { LlmClient, ResponseSchema } from '../llm/types.js';
import { generateValidated } from '../llm/types.js';
import { fallbackAllocation, REGIME_BANDS } from '../decision/ruleEngine.js';

const TREASURY_SYSTEM = [
  'You are the Treasury agent for an autonomous on-chain treasury holding sCSPR (risk-on, staking',
  'yield), csprUSD (risk-off stable refuge), and a small CSPR gas buffer.',
  'Propose a target allocation in basis points (scspr + csprusd + csprBuffer = 10000) and a single',
  'concrete action toward it for this cycle. Stay inside the regime band and the Risk hard limits.',
  'Respond with JSON only, matching the provided schema. No prose outside the JSON.',
].join(' ');

/** Gemini `responseSchema` (OpenAPI subset) mirroring `allocationProposalSchema`. */
const TREASURY_RESPONSE_SCHEMA: ResponseSchema = {
  type: 'object',
  properties: {
    targetBps: {
      type: 'object',
      properties: {
        scspr: { type: 'integer' },
        csprusd: { type: 'integer' },
        csprBuffer: { type: 'integer' },
      },
      required: ['scspr', 'csprusd', 'csprBuffer'],
    },
    action: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['Stake', 'Unstake', 'SwapToStable', 'SwapToRisk', 'NoOp'],
        },
        asset: { type: 'string', enum: ['CSPR', 'sCSPR', 'csprUSD'] },
        amount: { type: 'string' },
        target: { type: 'string' },
        minOut: { type: 'string' },
      },
      required: ['kind', 'asset', 'amount', 'target'],
    },
    expectedSlippageBps: { type: 'integer' },
    rationale: { type: 'string' },
  },
  required: ['targetBps', 'action', 'expectedSlippageBps', 'rationale'],
};

export interface ProposeInput {
  snapshot: MarketSnapshot;
  verdict: RiskVerdict;
  round: number;
  /** On a revise round, the Risk critic's rejection reasons to address. */
  reviseReasons?: string[];
}

export interface ProposalResult {
  proposal: AllocationProposal;
  source: 'llm' | 'fallback';
}

/** Deterministic fallback proposal: the regime's fallback allocation + a placeholder NoOp action
 * (the real action is sized deterministically downstream). */
export function fallbackProposal(verdict: RiskVerdict): AllocationProposal {
  return {
    targetBps: fallbackAllocation(verdict.regime),
    action: { kind: 'NoOp', asset: 'CSPR', amount: '0', target: '' },
    expectedSlippageBps: 0,
    rationale: `Deterministic fallback allocation for ${verdict.regime} regime.`,
  };
}

export class TreasuryAgent {
  constructor(private readonly llm: LlmClient) {}

  private prompt(input: ProposeInput): string {
    const band = REGIME_BANDS[input.verdict.regime];
    const lines = [
      `Regime: ${input.verdict.regime} (risk score ${input.verdict.riskScore}).`,
      `sCSPR weight must be within [${band.minScsprBps}, ${band.maxScsprBps}] bps and not exceed`,
      `the Risk hard limit ${input.verdict.hardLimits.maxScsprBps} bps.`,
      `Risk drivers: ${input.verdict.drivers.join('; ')}.`,
      `Current vault balances (base units): ${JSON.stringify(input.snapshot.vault)}.`,
      `csprUsdTwap=${input.snapshot.csprUsdTwap}, divergenceBps=${input.snapshot.twapSpotDivergenceBps}.`,
    ];
    if (input.reviseReasons?.length) {
      lines.push(
        `Your previous proposal was REJECTED by Risk. Address these and revise: ${input.reviseReasons.join(
          '; ',
        )}.`,
      );
    }
    return lines.join(' ');
  }

  async propose(input: ProposeInput): Promise<ProposalResult> {
    const llmProposal = await generateValidated<AllocationProposal>(
      this.llm,
      'allocationProposal',
      {
        system: TREASURY_SYSTEM,
        prompt: this.prompt(input),
        responseSchema: TREASURY_RESPONSE_SCHEMA,
        temperature: 0,
      },
    );
    if (llmProposal) return { proposal: llmProposal, source: 'llm' };
    return { proposal: fallbackProposal(input.verdict), source: 'fallback' };
  }
}
