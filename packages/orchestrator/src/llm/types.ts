/**
 * LLM client seam (spec §6.4) — the single interface the Risk/Treasury agents reason through.
 *
 * Every agent turn returns strict JSON validated against a `@sentinel/shared` schema, with one
 * repair retry, then a deterministic fallback (CLAUDE.md conventions). The client is injected as
 * an interface so the loop runs against live Gemini, while the deliberation tests and the §15.3
 * scenario harness run against a scripted client with no network — the same seam as every other
 * data source in the orchestrator.
 */
import { validate } from '@sentinel/shared';
import type { SchemaName } from '@sentinel/shared';

/** A Gemini-compatible `responseSchema` object (OpenAPI 3.0 subset; no `$ref`/`pattern`). */
export type ResponseSchema = Record<string, unknown>;

export interface LlmGenerateParams {
  /** System instruction (role + JSON-only discipline). */
  system: string;
  /** The user-turn prompt (the snapshot/verdict context for this turn). */
  prompt: string;
  /** Structured-output schema; nudges the model toward valid JSON (spec §6.4). */
  responseSchema?: ResponseSchema;
  /** Low by default for determinism (spec §6.4). */
  temperature?: number;
}

/** Minimal structured-JSON LLM client. Implementations parse the model's text to JSON. */
export interface LlmClient {
  /** Generate and JSON-parse one response. Throws on transport/parse failure. */
  generateJson(params: LlmGenerateParams): Promise<unknown>;
}

/**
 * Run one agent turn with parse-validate-retry (spec §6.4): generate → validate against `schema`;
 * on invalid output, retry once with the validation errors appended as a repair instruction; if it
 * still fails (or the transport throws), return `null` so the caller can fall back to the rule
 * engine. Never throws — the deterministic floor is always reachable.
 */
export async function generateValidated<T>(
  llm: LlmClient,
  schema: SchemaName,
  params: LlmGenerateParams,
): Promise<T | null> {
  // attempt 0 = first try; attempt 1 = one repair retry carrying the validation errors.
  for (let attempt = 0; attempt < 2; attempt++) {
    let lastErrors: string[];
    try {
      const data = await llm.generateJson(params);
      const result = validate<T>(schema, data);
      if (result.valid && result.data !== undefined) return result.data;
      lastErrors = result.errors ?? ['response did not match the schema'];
    } catch {
      lastErrors = ['the previous response was not valid JSON'];
    }
    if (attempt === 0) {
      params = {
        ...params,
        prompt: `${params.prompt}\n\nThe previous response was rejected for these reasons:\n- ${lastErrors.join(
          '\n- ',
        )}\nReturn corrected JSON that satisfies the schema. Output JSON only.`,
      };
    }
  }
  return null;
}

/**
 * Scripted client for tests and offline/scenario runs: returns queued responses in order. A
 * response may be a JSON value (returned as-is) or a string (parsed, so malformed-JSON repair
 * paths can be exercised). Throws when the queue is exhausted.
 */
export class ScriptedLlmClient implements LlmClient {
  private readonly queue: unknown[];
  constructor(responses: unknown[]) {
    this.queue = [...responses];
  }

  generateJson(): Promise<unknown> {
    if (this.queue.length === 0) throw new Error('ScriptedLlmClient: no scripted responses left');
    const next = this.queue.shift();
    if (typeof next === 'string') return Promise.resolve(JSON.parse(next));
    return Promise.resolve(next);
  }
}
