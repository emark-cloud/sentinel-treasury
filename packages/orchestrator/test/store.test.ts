import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashCanonical } from '@sentinel/shared';
import type { Decision, MarketSnapshot } from '@sentinel/shared';
import { FileArtifactStore, MemoryArtifactStore } from '../src/store/artifactStore.js';

const snapshot: MarketSnapshot = {
  timestamp: 1,
  csprUsdTwap: 1.02,
  csprUsdSpot: 1.0,
  twapSpotDivergenceBps: 196,
  volatility: { window: '24h', annualizedPct: 0 },
  liquidity: { csprUsdPool: { depthUsd: 1000 }, priceImpactCurve: [] },
  vault: { cspr: '1', scspr: '2', csprusd: '3' },
  provenance: [{ field: 'csprUsdTwap', label: 'VERIFIED', source: 'styks' }],
};

const decision: Decision = {
  consensus: true,
  source: 'llm',
  regime: 'Calm',
  finalAction: { kind: 'NoOp', asset: 'CSPR', amount: '0', target: '' },
  transcript: [],
  snapshotHash: hashCanonical(snapshot),
};

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('FileArtifactStore', () => {
  it('content-addresses by the artifact hash and round-trips for verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentinel-art-'));
    tmpDirs.push(dir);
    const store = new FileArtifactStore(dir);

    const snapHash = await store.putSnapshot('cycle-1', snapshot);
    const decHash = await store.putDecision('cycle-1', decision);
    expect(snapHash).toBe(hashCanonical(snapshot));
    expect(decHash).toBe(hashCanonical(decision));

    const fetched = await store.getByHash<MarketSnapshot>(snapHash);
    expect(fetched?.kind).toBe('snapshot');
    expect(hashCanonical(fetched?.artifact)).toBe(snapHash); // verification property

    const cycle = await store.listCycle('cycle-1');
    expect(cycle).toHaveLength(2);
    expect(cycle.map((c) => c.kind).sort()).toEqual(['decision', 'snapshot']);
  });

  it('returns undefined for a missing hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentinel-art-'));
    tmpDirs.push(dir);
    const store = new FileArtifactStore(dir);
    expect(await store.getByHash('00'.repeat(32))).toBeUndefined();
  });
});

describe('MemoryArtifactStore', () => {
  it('mirrors the file store behaviour in-memory', async () => {
    const store = new MemoryArtifactStore();
    const h = await store.putSnapshot('c', snapshot);
    expect(h).toBe(hashCanonical(snapshot));
    expect((await store.listCycle('c'))[0]?.hash).toBe(h);
    expect(await store.getByHash('ff'.repeat(32))).toBeUndefined();
  });
});
