/**
 * Gemini client (spec §6.4) — server-side calls to the Google AI Studio `generateContent` REST
 * endpoint. Implemented over `fetch` rather than the SDK so the orchestrator carries no extra
 * dependency and so structured output (`responseMimeType` + `responseSchema`) and `temperature`
 * map straight onto the documented request body.
 *
 * The API key is read from config (server-side only — never shipped to the browser; spec §6.4).
 * Transport/HTTP failures throw; `generateValidated` turns those into the deterministic fallback.
 */
import type { LlmClient, LlmGenerateParams } from './types.js';

export interface GeminiOptions {
  apiKey: string;
  /** e.g. `gemini-2.5-flash` (Flash tier for low loop latency — spec §6.4). */
  model: string;
  /** Override for the API base (tests / proxies). */
  baseUrl?: string;
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiClient implements LlmClient {
  private readonly baseUrl: string;
  constructor(private readonly opts: GeminiOptions) {
    if (!opts.apiKey) throw new Error('GeminiClient: missing apiKey');
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  async generateJson(params: LlmGenerateParams): Promise<unknown> {
    const url = `${this.baseUrl}/models/${this.opts.model}:generateContent?key=${this.opts.apiKey}`;
    const body = {
      systemInstruction: { parts: [{ text: params.system }] },
      contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        ...(params.responseSchema ? { responseSchema: params.responseSchema } : {}),
        temperature: params.temperature ?? 0.1,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as GenerateContentResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned no text content');
    return JSON.parse(text);
  }
}
