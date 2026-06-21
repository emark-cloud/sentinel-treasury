/**
 * JSON Schemas for every agent I/O (spec §6.3) — used for parse-validate-retry on each
 * LLM turn (one repair retry, else deterministic fallback) and to derive the Gemini
 * `responseSchema`. Draft-07; numeric on-chain amounts are decimal-string-typed.
 *
 * The schemas are the runtime contract; the TS interfaces in `src/types` are the
 * compile-time mirror. Keep them in sync — `test/schema.test.ts` checks representative
 * objects validate.
 */
import AjvDefault from 'ajv';
import type { ValidateFunction, Schema } from 'ajv';

// `ajv` ships CJS with an ESM-style `.d.ts`; under NodeNext the default import is
// mistyped as the module namespace. Node binds it to the Ajv class at runtime.
const Ajv = AjvDefault as unknown as typeof import('ajv').default;

const DECIMAL_STRING = { type: 'string', pattern: '^[0-9]+$' } as const;
const HEX32 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const BPS = { type: 'integer', minimum: 0, maximum: 10000 } as const;

export const ACTION_KINDS = ['Stake', 'Unstake', 'SwapToStable', 'SwapToRisk', 'NoOp'] as const;
export const REGIMES = ['Calm', 'Elevated', 'Stressed'] as const;
export const ASSETS = ['CSPR', 'sCSPR', 'csprUSD'] as const;

export const rebalanceActionSchema = {
  $id: 'sentinel:rebalance-action',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'asset', 'amount', 'target'],
  properties: {
    kind: { enum: ACTION_KINDS },
    asset: { enum: ASSETS },
    amount: DECIMAL_STRING,
    target: { type: 'string' },
    minOut: DECIMAL_STRING,
  },
} as const satisfies Schema;

export const riskVerdictSchema = {
  $id: 'sentinel:risk-verdict',
  type: 'object',
  additionalProperties: false,
  required: ['regime', 'riskScore', 'drivers', 'hardLimits', 'rationale'],
  properties: {
    regime: { enum: REGIMES },
    riskScore: { type: 'number', minimum: 0, maximum: 100 },
    drivers: { type: 'array', items: { type: 'string' } },
    hardLimits: {
      type: 'object',
      additionalProperties: false,
      required: ['maxScsprBps', 'maxActionUsd'],
      properties: {
        maxScsprBps: BPS,
        maxActionUsd: { type: 'number', minimum: 0 },
      },
    },
    rationale: { type: 'string' },
  },
} as const satisfies Schema;

export const allocationProposalSchema = {
  $id: 'sentinel:allocation-proposal',
  type: 'object',
  additionalProperties: false,
  required: ['targetBps', 'action', 'expectedSlippageBps', 'rationale'],
  properties: {
    targetBps: {
      type: 'object',
      additionalProperties: false,
      required: ['scspr', 'csprusd', 'csprBuffer'],
      properties: { scspr: BPS, csprusd: BPS, csprBuffer: BPS },
    },
    action: { $ref: 'sentinel:rebalance-action' },
    expectedSlippageBps: { type: 'integer', minimum: 0 },
    rationale: { type: 'string' },
  },
} as const satisfies Schema;

export const deliberationTurnSchema = {
  $id: 'sentinel:deliberation-turn',
  type: 'object',
  additionalProperties: false,
  required: ['round', 'role', 'kind', 'rationale'],
  properties: {
    round: { type: 'integer', minimum: 1 },
    role: { enum: ['Treasury', 'Risk'] },
    kind: { enum: ['propose', 'revise', 'approve', 'reject'] },
    proposal: { $ref: 'sentinel:allocation-proposal' },
    reasons: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
} as const satisfies Schema;

export const decisionSchema = {
  $id: 'sentinel:decision',
  type: 'object',
  additionalProperties: false,
  required: ['consensus', 'source', 'regime', 'finalAction', 'transcript', 'snapshotHash'],
  properties: {
    consensus: { type: 'boolean' },
    source: { enum: ['llm', 'fallback'] },
    regime: { enum: REGIMES },
    finalAction: { $ref: 'sentinel:rebalance-action' },
    transcript: { type: 'array', items: { $ref: 'sentinel:deliberation-turn' } },
    snapshotHash: HEX32,
  },
} as const satisfies Schema;

export const marketSnapshotSchema = {
  $id: 'sentinel:market-snapshot',
  type: 'object',
  additionalProperties: false,
  required: [
    'timestamp',
    'csprUsdTwap',
    'csprUsdSpot',
    'twapSpotDivergenceBps',
    'volatility',
    'liquidity',
    'vault',
    'provenance',
  ],
  properties: {
    timestamp: { type: 'integer' },
    csprUsdTwap: { type: 'number' },
    csprUsdSpot: { type: 'number' },
    twapSpotDivergenceBps: { type: 'number' },
    volatility: {
      type: 'object',
      additionalProperties: false,
      required: ['window', 'annualizedPct'],
      properties: {
        window: { enum: ['1h', '24h'] },
        annualizedPct: { type: 'number' },
      },
    },
    liquidity: {
      type: 'object',
      additionalProperties: false,
      required: ['csprUsdPool', 'priceImpactCurve'],
      properties: {
        csprUsdPool: {
          type: 'object',
          additionalProperties: false,
          required: ['depthUsd'],
          properties: { depthUsd: { type: 'number' } },
        },
        priceImpactCurve: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sizeUsd', 'bps'],
            properties: { sizeUsd: { type: 'number' }, bps: { type: 'number' } },
          },
        },
      },
    },
    premiumSignal: {
      type: 'object',
      additionalProperties: false,
      required: ['riskIndex', 'source', 'paid'],
      properties: {
        riskIndex: { type: 'number', minimum: 0, maximum: 100 },
        source: { const: 'premium-x402' },
        paid: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'settleTx'],
          properties: { amount: DECIMAL_STRING, settleTx: { type: 'string' } },
        },
      },
    },
    vault: {
      type: 'object',
      additionalProperties: false,
      required: ['cspr', 'scspr', 'csprusd'],
      properties: { cspr: DECIMAL_STRING, scspr: DECIMAL_STRING, csprusd: DECIMAL_STRING },
    },
    provenance: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'label', 'source'],
        properties: {
          field: { type: 'string' },
          label: { enum: ['VERIFIED', 'COMPUTED', 'ESTIMATED'] },
          source: { type: 'string' },
        },
      },
    },
  },
} as const satisfies Schema;

/** All agent-I/O schemas, registered together so `$ref`s resolve. */
export const schemas = {
  marketSnapshot: marketSnapshotSchema,
  riskVerdict: riskVerdictSchema,
  allocationProposal: allocationProposalSchema,
  rebalanceAction: rebalanceActionSchema,
  deliberationTurn: deliberationTurnSchema,
  decision: decisionSchema,
} as const;

export type SchemaName = keyof typeof schemas;

const ajv = new Ajv({ allErrors: true, strict: false });
for (const schema of [
  rebalanceActionSchema,
  allocationProposalSchema,
  deliberationTurnSchema,
  riskVerdictSchema,
  decisionSchema,
  marketSnapshotSchema,
]) {
  ajv.addSchema(schema);
}

/** Compiled validator for an agent-I/O schema (cached by Ajv). */
export function getValidator(name: SchemaName): ValidateFunction {
  const id = schemas[name].$id;
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`schema not registered: ${name} (${id})`);
  return validate as ValidateFunction;
}

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  errors?: string[];
}

/**
 * Validate `data` against a named schema. On success returns the typed value; on
 * failure returns human-readable Ajv error strings for the parse-validate-retry repair
 * prompt.
 */
export function validate<T>(name: SchemaName, data: unknown): ValidationResult<T> {
  const fn = getValidator(name);
  const valid = fn(data);
  if (valid) return { valid: true, data: data as T };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
  return { valid: false, errors };
}
