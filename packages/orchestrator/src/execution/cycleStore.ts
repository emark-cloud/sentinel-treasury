/**
 * Cycle journal (spec §8.5) — the idempotency + crash-recovery ledger. Each loop iteration has a
 * unique `cycleId`; the journal records the intended action, then the submitted `deployHash`, then
 * the finality result. On restart the execution service reconciles any `submitted` record against
 * the chain before starting new work, so a transaction that finalized while we were down is never
 * re-submitted (no double-execution).
 *
 * The state machine: `pending` (intent persisted, not yet on-chain) → `submitted` (deploy hash
 * known, awaiting finality) → `finalized` | `failed`. A `skipped` terminal marks NoOp cycles that
 * never touched the chain.
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RebalanceAction } from '@sentinel/shared';

export type CycleStatus = 'pending' | 'submitted' | 'finalized' | 'failed' | 'skipped';

export interface CycleRecord {
  cycleId: string;
  status: CycleStatus;
  /** The single intended action for this cycle. */
  action: RebalanceAction;
  perceptionHash: string;
  decisionHash: string;
  /** Submitted transaction hash (set at `submitted`). */
  deployHash?: string;
  /** Final on-chain result, once known. */
  result?: 'Success' | 'Reverted' | 'Skipped';
  errorMessage?: string;
  gasMotes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CycleStore {
  get(cycleId: string): Promise<CycleRecord | undefined>;
  put(record: CycleRecord): Promise<void>;
  list(): Promise<CycleRecord[]>;
}

/** Records that were submitted but whose finality we have not yet recorded. */
export async function inFlight(store: CycleStore): Promise<CycleRecord[]> {
  return (await store.list()).filter((r) => r.status === 'submitted');
}

/** Filesystem-backed journal; one `<cycleId>.json` per cycle. */
export class FileCycleStore implements CycleStore {
  constructor(private readonly rootDir: string) {}

  private path(cycleId: string): string {
    // Cycle ids are caller-controlled; keep them filesystem-safe.
    return join(this.rootDir, `${cycleId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  async get(cycleId: string): Promise<CycleRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path(cycleId), 'utf8')) as CycleRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async put(record: CycleRecord): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.path(record.cycleId), JSON.stringify(record, null, 2), 'utf8');
  }

  async list(): Promise<CycleRecord[]> {
    await mkdir(this.rootDir, { recursive: true });
    const files = await readdir(this.rootDir);
    const out: CycleRecord[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      out.push(JSON.parse(await readFile(join(this.rootDir, f), 'utf8')) as CycleRecord);
    }
    return out;
  }
}

/** In-memory journal for tests / dry runs. */
export class MemoryCycleStore implements CycleStore {
  private readonly byId = new Map<string, CycleRecord>();

  get(cycleId: string): Promise<CycleRecord | undefined> {
    const r = this.byId.get(cycleId);
    return Promise.resolve(r ? { ...r } : undefined);
  }

  put(record: CycleRecord): Promise<void> {
    this.byId.set(record.cycleId, { ...record });
    return Promise.resolve();
  }

  list(): Promise<CycleRecord[]> {
    return Promise.resolve([...this.byId.values()].map((r) => ({ ...r })));
  }
}
