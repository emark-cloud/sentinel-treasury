/**
 * Receipt verification (design.md §5.6, spec §9.2) — runs in the browser.
 *
 * Recomputes blake2b-256 over canonical JSON of the retained MarketSnapshot / Decision
 * artifacts and asserts equality with the on-chain receipt's `perception_hash` /
 * `decision_hash`. Uses the exact same `@sentinel/shared` primitive the orchestrator and
 * the contract agree on — so a match here is the real proof, not a mock.
 */
import { hashCanonical } from '@sentinel/shared';
import type { Cycle } from './types';

export interface VerifyCheck {
  label: string;
  computed: string;
  onChain: string;
  ok: boolean;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

export function verifyCycle(cycle: Cycle): VerifyResult {
  const perception = hashCanonical(cycle.snapshot);
  const decision = hashCanonical(cycle.decision);
  const checks: VerifyCheck[] = [
    {
      label: 'blake2b(MarketSnapshot) == perception_hash',
      computed: perception,
      onChain: cycle.receipt.perceptionHash,
      ok: perception === cycle.receipt.perceptionHash,
    },
    {
      label: 'blake2b(Decision) == decision_hash',
      computed: decision,
      onChain: cycle.receipt.decisionHash,
      ok: decision === cycle.receipt.decisionHash,
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
