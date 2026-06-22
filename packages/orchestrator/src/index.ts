/**
 * @sentinel/orchestrator — the perceive→decide→act→prove loop controller.
 *
 * Phase 3 (perception & data) public surface: config, artifact store, data service + sources,
 * the x402 payment stack (premium endpoint, client, budget guard), and the Scout agent that
 * assembles the hashed `MarketSnapshot`. Decision (Phase 4) and execution/proof (Phase 5) land
 * on top of these seams.
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
