import { describe, it, expect } from 'vitest';
import type { MarketSnapshot, Decision, Receipt } from '@sentinel/shared';
import { MemoryArtifactStore } from '../src/store/artifactStore.js';
import type { ChainClient } from '../src/execution/chainClient.js';
import { ByteWriter } from '../src/execution/clbytes.js';
import { odraDictionaryItemKey } from '../src/data/onchainReader.js';
import { encodeReceipt } from '../src/proof/receiptCodec.js';
import {
  AuditLogReceiptReader,
  AUDITLOG_COUNT_FIELD_INDEX,
  AUDITLOG_RECEIPTS_FIELD_INDEX,
} from '../src/proof/receiptReader.js';
import { verifyReceipt, verifyByActionId } from '../src/proof/verify.js';
import { transactionUrl } from '../src/proof/csprLive.js';

const h32 = (b: string) => b.repeat(32);

// Minimal artifacts — verifyReceipt only needs canonical-JSON-hashable objects.
const snapshot = { timestamp: 1, csprUsdTwap: 0.003 } as unknown as MarketSnapshot;
const decision = { consensus: true, regime: 'Stressed' } as unknown as Decision;

function receiptWith(
  perceptionHash: string,
  decisionHash: string,
  deployHash = h32('de'),
): Receipt {
  return {
    actionId: '0',
    timestamp: '1',
    agent: h32('a1'),
    actionKind: 'SwapToStable',
    regime: 'Stressed',
    perceptionHash,
    decisionHash,
    preAllocBps: { scspr: 6000, csprusd: 4000, cspr: 0 },
    postAllocBps: { scspr: 2000, csprusd: 8000, cspr: 0 },
    amount: '1000000000',
    notionalUsd: '3070000',
    target: h32('11'),
    deployHash,
    result: 'Success',
    csprUsdTwap: '307',
  };
}

describe('verifyReceipt (spec §9.2)', () => {
  it('verifies when the stored artifacts recompute to the on-chain hashes', async () => {
    const store = new MemoryArtifactStore();
    const pHash = await store.putSnapshot('c1', snapshot);
    const dHash = await store.putDecision('c1', decision);

    const result = await verifyReceipt(receiptWith(pHash, dHash), store);
    expect(result.verified).toBe(true);
    expect(result.perception.matches).toBe(true);
    expect(result.decision.matches).toBe(true);
    expect(result.deployHashPending).toBe(false);
    expect(result.explorerUrl).toBe(transactionUrl(h32('de')));
  });

  it('fails verification when an artifact is missing or tampered', async () => {
    const store = new MemoryArtifactStore();
    const dHash = await store.putDecision('c1', decision);
    const result = await verifyReceipt(receiptWith(h32('00'), dHash), store);
    expect(result.verified).toBe(false);
    expect(result.perception.found).toBe(false);
    expect(result.decision.matches).toBe(true);
  });

  it('flags a zero deploy hash as pending (vault cross-contract record, D-007)', async () => {
    const store = new MemoryArtifactStore();
    const pHash = await store.putSnapshot('c1', snapshot);
    const dHash = await store.putDecision('c1', decision);
    const result = await verifyReceipt(receiptWith(pHash, dHash, h32('00')), store);
    expect(result.deployHashPending).toBe(true);
  });
});

describe('AuditLogReceiptReader + verifyByActionId', () => {
  it('reads a receipt from the Odra state dictionary and verifies it end-to-end', async () => {
    const contractHash = h32('ad');
    const store = new MemoryArtifactStore();
    const pHash = await store.putSnapshot('c1', snapshot);
    const dHash = await store.putDecision('c1', decision);
    const receipt = receiptWith(pHash, dHash);

    // Populate a fake chain dictionary at the keys the reader derives.
    const dict = new Map<string, Uint8Array>();
    dict.set(odraDictionaryItemKey(AUDITLOG_COUNT_FIELD_INDEX), new ByteWriter().u64(1n).finish());
    const receiptKey = odraDictionaryItemKey(
      AUDITLOG_RECEIPTS_FIELD_INDEX,
      new ByteWriter().u64(0n).finish(),
    );
    dict.set(receiptKey, encodeReceipt(receipt));

    const chain: ChainClient = {
      submit: () => Promise.reject(new Error('unused')),
      getStatus: () => Promise.resolve(null),
      getDictionaryBytes: (_c, _n, key) => Promise.resolve(dict.get(key) ?? null),
    };

    const reader = new AuditLogReceiptReader(chain, contractHash);
    expect(await reader.count()).toBe(1);
    const read = await reader.get(0);
    expect(read).toEqual(receipt);

    const result = await verifyByActionId(reader, 0, store);
    expect(result?.verified).toBe(true);
  });
});
