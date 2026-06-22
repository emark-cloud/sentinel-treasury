/**
 * Off-chain artifact store (spec §9.1) — retains the full `MarketSnapshot` and `Decision`
 * JSON whose blake2b-256 hashes are committed on-chain in the `Receipt`. This is what makes
 * the audit log verifiable: anyone can fetch the artifact, recompute the hash with the same
 * canonical-JSON util in `@sentinel/shared`, and assert equality with `perception_hash` /
 * `decision_hash` (spec §9.2).
 *
 * Storage is content-addressed by the artifact's own hash (so a tampered file cannot keep its
 * name) plus a per-cycle index for retrieval-by-cycle. Default backend is the local filesystem;
 * the interface allows swapping in IPFS/object storage later (spec §16 open question).
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hashCanonical } from '@sentinel/shared';
import type { MarketSnapshot, Decision } from '@sentinel/shared';

export type ArtifactKind = 'snapshot' | 'decision';

export interface StoredArtifact<T> {
  hash: string;
  cycleId: string;
  kind: ArtifactKind;
  artifact: T;
}

export interface ArtifactStore {
  putSnapshot(cycleId: string, snapshot: MarketSnapshot): Promise<string>;
  putDecision(cycleId: string, decision: Decision): Promise<string>;
  getByHash<T>(hash: string): Promise<StoredArtifact<T> | undefined>;
  listCycle(cycleId: string): Promise<StoredArtifact<unknown>[]>;
}

interface Envelope {
  hash: string;
  cycleId: string;
  kind: ArtifactKind;
  storedAt: number;
  artifact: unknown;
}

/**
 * Filesystem-backed artifact store. Files are named `<hash>.json`; an envelope wraps the
 * artifact with its cycle id and kind so retrieval-by-cycle and verification both work from
 * the file alone.
 */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir: string) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  private path(hash: string): string {
    return join(this.rootDir, `${hash}.json`);
  }

  private async put(cycleId: string, kind: ArtifactKind, artifact: unknown): Promise<string> {
    // The stored hash MUST equal the on-chain receipt hash, so hash the bare artifact (not the
    // envelope) with the same canonical-JSON util the contract proof relies on.
    const hash = hashCanonical(artifact);
    const envelope: Envelope = { hash, cycleId, kind, storedAt: Date.now(), artifact };
    await this.ensureDir();
    await writeFile(this.path(hash), JSON.stringify(envelope, null, 2), 'utf8');
    return hash;
  }

  putSnapshot(cycleId: string, snapshot: MarketSnapshot): Promise<string> {
    return this.put(cycleId, 'snapshot', snapshot);
  }

  putDecision(cycleId: string, decision: Decision): Promise<string> {
    return this.put(cycleId, 'decision', decision);
  }

  async getByHash<T>(hash: string): Promise<StoredArtifact<T> | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path(hash), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const env = JSON.parse(raw) as Envelope;
    return { hash: env.hash, cycleId: env.cycleId, kind: env.kind, artifact: env.artifact as T };
  }

  async listCycle(cycleId: string): Promise<StoredArtifact<unknown>[]> {
    await this.ensureDir();
    const files = await readdir(this.rootDir);
    const out: StoredArtifact<unknown>[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await readFile(join(this.rootDir, f), 'utf8');
      const env = JSON.parse(raw) as Envelope;
      if (env.cycleId === cycleId) {
        out.push({ hash: env.hash, cycleId: env.cycleId, kind: env.kind, artifact: env.artifact });
      }
    }
    return out;
  }
}

/** In-memory store for tests and dry-run loops (no disk writes). */
export class MemoryArtifactStore implements ArtifactStore {
  private readonly byHash = new Map<string, Envelope>();

  private put(cycleId: string, kind: ArtifactKind, artifact: unknown): string {
    const hash = hashCanonical(artifact);
    this.byHash.set(hash, { hash, cycleId, kind, storedAt: Date.now(), artifact });
    return hash;
  }

  putSnapshot(cycleId: string, snapshot: MarketSnapshot): Promise<string> {
    return Promise.resolve(this.put(cycleId, 'snapshot', snapshot));
  }

  putDecision(cycleId: string, decision: Decision): Promise<string> {
    return Promise.resolve(this.put(cycleId, 'decision', decision));
  }

  getByHash<T>(hash: string): Promise<StoredArtifact<T> | undefined> {
    const env = this.byHash.get(hash);
    if (!env) return Promise.resolve(undefined);
    return Promise.resolve({
      hash: env.hash,
      cycleId: env.cycleId,
      kind: env.kind,
      artifact: env.artifact as T,
    });
  }

  listCycle(cycleId: string): Promise<StoredArtifact<unknown>[]> {
    const out: StoredArtifact<unknown>[] = [];
    for (const env of this.byHash.values()) {
      if (env.cycleId === cycleId) {
        out.push({ hash: env.hash, cycleId: env.cycleId, kind: env.kind, artifact: env.artifact });
      }
    }
    return Promise.resolve(out);
  }
}
