/**
 * Cycle history store — the runner's append-only log of completed {@link CycleView}s plus a
 * publish/subscribe seam so the HTTP server can stream new cycles over SSE as they land.
 *
 * Persisted to one JSON file (newest cycles bounded by `cap`) so a dashboard reload after a runner
 * restart still shows recent real activity; an in-memory variant backs tests. This is the *rich*
 * cycle feed (full snapshot/decision/receipt for replay); the verifiable backbone is the on-chain
 * AuditLog read separately by the dashboard.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CycleView } from '@sentinel/shared';

export type CycleSubscriber = (cycle: CycleView) => void;

export interface CycleHistoryStore {
  /** Append a completed cycle, notify subscribers, and persist (newest-first, bounded). */
  append(cycle: CycleView): Promise<void>;
  /** Most recent `limit` cycles, newest first. */
  recent(limit: number): Promise<CycleView[]>;
  /** Subscribe to cycles appended after this call. Returns an unsubscribe fn. */
  subscribe(fn: CycleSubscriber): () => void;
}

abstract class BaseCycleHistoryStore implements CycleHistoryStore {
  protected cycles: CycleView[] = []; // newest first
  private readonly subscribers = new Set<CycleSubscriber>();

  constructor(protected readonly cap = 200) {}

  async append(cycle: CycleView): Promise<void> {
    this.cycles = [cycle, ...this.cycles].slice(0, this.cap);
    await this.persist();
    for (const fn of this.subscribers) {
      try {
        fn(cycle);
      } catch {
        // A failing subscriber (e.g. a closed SSE socket) must not break the append.
      }
    }
  }

  recent(limit: number): Promise<CycleView[]> {
    return Promise.resolve(this.cycles.slice(0, Math.max(0, limit)));
  }

  subscribe(fn: CycleSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  protected abstract persist(): Promise<void>;
}

/** Filesystem-backed history (single JSON file, bounded to `cap` newest cycles). */
export class FileCycleHistoryStore extends BaseCycleHistoryStore {
  private loaded = false;

  constructor(
    private readonly filePath: string,
    cap = 200,
  ) {
    super(cap);
  }

  /** Load any prior history from disk (call once at startup). Best-effort. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as CycleView[];
      if (Array.isArray(parsed)) this.cycles = parsed.slice(0, this.cap);
    } catch {
      // No prior history (fresh host) — start empty.
    }
  }

  protected async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.cycles), 'utf8');
  }
}

/** In-memory history for tests / dry runs. */
export class MemoryCycleHistoryStore extends BaseCycleHistoryStore {
  protected persist(): Promise<void> {
    return Promise.resolve();
  }
}
