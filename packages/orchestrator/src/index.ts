/**
 * @sentinel/orchestrator — the perceive→decide→act→prove loop controller.
 *
 * Phase 3 (perception & data) public surface: config, artifact store, data service + sources,
 * the x402 payment stack (premium endpoint, client, budget guard), and the Scout agent that
 * assembles the hashed `MarketSnapshot`. Phase 4 (agents & decision) adds the LLM seam, the
 * Risk/Treasury agents, the deterministic rule engine, and the deliberation/decision engine.
 * Execution/proof (Phase 5) lands on top of these seams.
 */
import { hashCanonical } from '@sentinel/shared';
import type { Decision } from '@sentinel/shared';

export function fingerprintDecision(decision: Decision): string {
  return hashCanonical(decision);
}

// Config
export * from './config/env.js';

// Off-chain artifact store (spec §9)
export * from './store/artifactStore.js';

// Data service + perception sources (spec §5)
export * from './data/dataService.js';
export * from './data/onchainReader.js';
export * from './data/csprCloud.js';
export * from './data/mcpClient.js';

// x402 payment stack (spec §5.2, §11)
export * from './x402/types.js';
export * from './x402/eip712.js';
export * from './x402/client.js';
export * from './x402/budgetGuard.js';
export * from './x402/premiumServer.js';

// Scout agent (spec §6.1)
export * from './agents/scout.js';

// LLM seam (spec §6.4)
export * from './llm/types.js';
export * from './llm/gemini.js';

// Risk & Treasury agents (spec §6.1)
export * from './agents/risk.js';
export * from './agents/treasury.js';

// Decision layer: rule engine, normalization, sizing, deliberation (spec §6.2, §6.5, §7)
export * from './decision/types.js';
export * from './decision/ruleEngine.js';
export * from './decision/normalize.js';
export * from './decision/sizing.js';
export * from './decision/deliberate.js';
