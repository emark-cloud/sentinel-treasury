/**
 * Execution Service (spec §8) — the ACT stage. Turns a decided `RebalanceAction` into a signed
 * `execute_rebalance` `TransactionV1`, submits it with the bounded agent key, and polls for
 * deterministic finality (Zug), capturing the `deployHash` and result for the receipt.
 *
 * Idempotency (spec §8.5) is enforced via the {@link CycleStore}: the intended action is journaled
 * before submission, the `deployHash` on submission, and the result on finality. A cycle whose
 * record is already `submitted`/`finalized` is never re-submitted — on restart, `reconcile()`
 * settles any in-flight transaction against the chain first.
 *
 * NoOp cycles never touch the chain (the vault would reject the empty target anyway); they are
 * journaled `skipped` so the loop still has a record.
 */
import type { RebalanceAction, Regime, ActionResult } from '@sentinel/shared';
import type { ChainClient, TxStatus } from './chainClient.js';
import type { TxSigner } from './signer.js';
import type { CycleStore, CycleRecord } from './cycleStore.js';
import { inFlight } from './cycleStore.js';
import { buildExecuteRebalanceTx } from './transaction.js';
import type { SwapRoutes } from './transaction.js';

export interface ExecutionConfig {
  chainName: string;
  vaultPackageHash: string;
  routes: SwapRoutes;
  /** Gas payment in motes for `execute_rebalance` (cross-contract swaps are the costly case). */
  paymentMotes: number;
  /** Finality poll interval / overall timeout (ms). */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  ttlMs?: number;
}

/** Injected time source so polling/reconciliation are deterministic in tests. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface ExecutionOutcome {
  cycleId: string;
  status: CycleRecord['status'];
  deployHash?: string;
  /** `Pending` when submitted but finality not yet observed within the poll window. */
  result: ActionResult | 'Pending';
  success: boolean;
  errorMessage?: string;
  gasMotes?: string;
}

export interface ExecuteRequest {
  cycleId: string;
  action: RebalanceAction;
  regime: Regime;
  perceptionHash: string;
  decisionHash: string;
}

const DEFAULT_POLL_INTERVAL = 5_000;
const DEFAULT_POLL_TIMEOUT = 180_000;

export class ExecutionService {
  private readonly pollInterval: number;
  private readonly pollTimeout: number;

  constructor(
    private readonly chain: ChainClient,
    private readonly signer: TxSigner,
    private readonly store: CycleStore,
    private readonly cfg: ExecutionConfig,
    private readonly clock: Clock = systemClock,
  ) {
    this.pollInterval = cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
    this.pollTimeout = cfg.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT;
  }

  /** Execute one cycle's action, journaling each transition. Idempotent per `cycleId`. */
  async execute(req: ExecuteRequest): Promise<ExecutionOutcome> {
    const existing = await this.store.get(req.cycleId);
    if (existing) return this.resumeExisting(existing);

    if (req.action.kind === 'NoOp') {
      const rec = this.newRecord(req, 'skipped');
      rec.result = 'Skipped';
      await this.store.put(rec);
      return this.toOutcome(rec);
    }

    // 1. Journal intent before anything hits the chain (crash before submit ⇒ replayable).
    const record = this.newRecord(req, 'pending');
    await this.store.put(record);

    // 2. Build → sign → submit.
    const tx = buildExecuteRebalanceTx({
      agentPublicKeyHex: this.signer.publicKeyHex,
      vaultPackageHash: this.cfg.vaultPackageHash,
      chainName: this.cfg.chainName,
      paymentMotes: this.cfg.paymentMotes,
      action: req.action,
      regime: req.regime,
      perceptionHash: req.perceptionHash,
      decisionHash: req.decisionHash,
      routes: this.cfg.routes,
      ...(this.cfg.ttlMs !== undefined ? { ttlMs: this.cfg.ttlMs } : {}),
    });
    this.signer.sign(tx);
    const deployHash = await this.chain.submit(tx);

    record.deployHash = deployHash;
    record.status = 'submitted';
    record.updatedAt = this.clock.now();
    await this.store.put(record);

    // 3. Poll to finality and settle the journal.
    const status = await this.pollToFinality(deployHash);
    return this.settle(record, status);
  }

  /**
   * Reconcile in-flight transactions after a restart (spec §8.5). Polls each `submitted` record's
   * current chain status and settles those that have finalized. Returns the updated records.
   */
  async reconcile(): Promise<CycleRecord[]> {
    const pending = await inFlight(this.store);
    const settled: CycleRecord[] = [];
    for (const record of pending) {
      if (!record.deployHash) continue;
      const status = await this.chain.getStatus(record.deployHash);
      if (status?.finalized) {
        this.settle(record, status);
        settled.push(await this.store.get(record.cycleId).then((r) => r ?? record));
      }
    }
    return settled;
  }

  /** Poll until the transaction finalizes or the timeout elapses. */
  private async pollToFinality(txHash: string): Promise<TxStatus | null> {
    const deadline = this.clock.now() + this.pollTimeout;
    // First check is immediate; then back off by the interval until the deadline.
    for (;;) {
      const status = await this.chain.getStatus(txHash);
      if (status?.finalized) return status;
      if (this.clock.now() + this.pollInterval > deadline) return status;
      await this.clock.sleep(this.pollInterval);
    }
  }

  private async settle(record: CycleRecord, status: TxStatus | null): Promise<ExecutionOutcome> {
    if (!status?.finalized) {
      // Left in-flight; a later reconcile() will settle it.
      record.status = 'submitted';
      delete record.result;
      record.updatedAt = this.clock.now();
      await this.store.put(record);
      return this.toOutcome(record);
    }
    record.status = status.success ? 'finalized' : 'failed';
    record.result = status.success ? 'Success' : 'Reverted';
    if (status.errorMessage !== undefined) record.errorMessage = status.errorMessage;
    if (status.gasMotes !== undefined) record.gasMotes = status.gasMotes;
    record.updatedAt = this.clock.now();
    await this.store.put(record);
    return this.toOutcome(record);
  }

  /** Settle or report an already-journaled cycle without re-submitting. */
  private async resumeExisting(record: CycleRecord): Promise<ExecutionOutcome> {
    if (record.status === 'submitted' && record.deployHash) {
      const status = await this.pollToFinality(record.deployHash);
      return this.settle(record, status);
    }
    return this.toOutcome(record);
  }

  private newRecord(req: ExecuteRequest, status: CycleRecord['status']): CycleRecord {
    const t = this.clock.now();
    return {
      cycleId: req.cycleId,
      status,
      action: req.action,
      perceptionHash: req.perceptionHash,
      decisionHash: req.decisionHash,
      createdAt: t,
      updatedAt: t,
    };
  }

  private toOutcome(record: CycleRecord): ExecutionOutcome {
    const result: ActionResult | 'Pending' =
      record.status === 'submitted' || record.status === 'pending'
        ? 'Pending'
        : (record.result ?? 'Reverted');
    return {
      cycleId: record.cycleId,
      status: record.status,
      ...(record.deployHash ? { deployHash: record.deployHash } : {}),
      result,
      success: record.status === 'finalized' || record.status === 'skipped',
      ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
      ...(record.gasMotes ? { gasMotes: record.gasMotes } : {}),
    };
  }
}
