/**
 * The verification procedure anyone can run (spec §9.2) — the step that closes the black-box gap:
 * the agent's *stated* reasoning is cryptographically bound to its *actual* on-chain action.
 *
 *   1. Read `Receipt(action_id)` from the AuditLog (on-chain) — {@link ReceiptSource}.
 *   2. Fetch the off-chain `MarketSnapshot` + `Decision` artifacts for that action.
 *   3. Recompute blake2b-256 over canonical JSON and assert equality with the receipt's
 *      `perceptionHash` / `decisionHash`.
 *   4. Surface the cspr.live link for `deployHash` so token movements can be checked by eye.
 *
 * The recompute uses the *same* `hashCanonical` util the proof was produced with (`@sentinel/
 * shared`), so a verifier reproduces the hashes independently rather than trusting the store.
 */
import { hashCanonical } from '@sentinel/shared';
import type { Receipt } from '@sentinel/shared';
import type { ArtifactStore } from '../store/artifactStore.js';
import type { ReceiptSource } from './receiptReader.js';
import { transactionUrl } from './csprLive.js';

export interface ArtifactCheck {
  /** The hash recorded on-chain in the receipt. */
  onChainHash: string;
  /** Whether the matching artifact was found in the off-chain store. */
  found: boolean;
  /** blake2b recomputed from the fetched artifact (absent if not found). */
  recomputed?: string;
  /** True when the artifact was found and its recomputed hash equals the on-chain hash. */
  matches: boolean;
}

export interface VerificationResult {
  actionId: string;
  perception: ArtifactCheck;
  decision: ArtifactCheck;
  /** Both artifacts found and both hashes match. */
  verified: boolean;
  deployHash: string;
  /** Zero deploy hash means the vault recorded the receipt cross-contract (D-007). */
  deployHashPending: boolean;
  explorerUrl: string;
}

const ZERO_HASH = '0'.repeat(64);

async function checkArtifact(store: ArtifactStore, onChainHash: string): Promise<ArtifactCheck> {
  const stored = await store.getByHash<unknown>(onChainHash);
  if (!stored) return { onChainHash, found: false, matches: false };
  const recomputed = hashCanonical(stored.artifact);
  return { onChainHash, found: true, recomputed, matches: recomputed === onChainHash };
}

/** Verify a single receipt against the off-chain artifact store (spec §9.2 steps 2–4). */
export async function verifyReceipt(
  receipt: Receipt,
  store: ArtifactStore,
): Promise<VerificationResult> {
  const [perception, decision] = await Promise.all([
    checkArtifact(store, receipt.perceptionHash),
    checkArtifact(store, receipt.decisionHash),
  ]);
  const deployHashPending = receipt.deployHash === ZERO_HASH;
  return {
    actionId: receipt.actionId,
    perception,
    decision,
    verified: perception.matches && decision.matches,
    deployHash: receipt.deployHash,
    deployHashPending,
    explorerUrl: transactionUrl(deployHashPending ? '' : receipt.deployHash),
  };
}

/** Fetch a receipt by `action_id` from the on-chain log, then verify it (spec §9.2 full). */
export async function verifyByActionId(
  source: ReceiptSource,
  actionId: number,
  store: ArtifactStore,
): Promise<VerificationResult | null> {
  const receipt = await source.get(actionId);
  if (!receipt) return null;
  return verifyReceipt(receipt, store);
}
