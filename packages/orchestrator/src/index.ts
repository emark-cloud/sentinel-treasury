/**
 * @sentinel/orchestrator — the perceive→decide→act→prove loop controller.
 *
 * Phase 1 stub: verifies the workspace wiring to @sentinel/shared. The agents, data
 * service, x402 client, execution service, and rule engine land in Phases 3–5.
 */
import { hashCanonical } from '@sentinel/shared';
import type { Decision } from '@sentinel/shared';

export function fingerprintDecision(decision: Decision): string {
  return hashCanonical(decision);
}
