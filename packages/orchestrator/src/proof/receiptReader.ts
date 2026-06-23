/**
 * Read `Receipt`s back from the AuditLog (spec §9.2 step 1). The AuditLog is an Odra contract, so
 * all storage lives in one `state` dictionary keyed by `hex(blake2b256(u32_be(field_index) ++
 * mapping_key))` — the same derivation the Styks reader uses (`data/onchainReader.ts`, D-012).
 *
 * In `audit_log.rs` declaration order the storage fields are `admin(0) vault(1) agent(2) count(3)
 * receipts(4)`, so `count` is the `Var` at index 3 and each receipt is the `Mapping<u64,Receipt>`
 * entry at index 4 keyed by the u64 index. The indices are overridable (a live read should confirm
 * them the way D-012 confirmed Styks); the reader is best-effort and returns `null` on any miss.
 */
import type { Receipt } from '@sentinel/shared';
import type { ChainClient } from '../execution/chainClient.js';
import { ByteReader, ByteWriter } from '../execution/clbytes.js';
import { odraDictionaryItemKey } from '../data/onchainReader.js';
import { parseReceipt } from './receiptCodec.js';

const ODRA_STATE_DICTIONARY = 'state';
export const AUDITLOG_COUNT_FIELD_INDEX = 3;
export const AUDITLOG_RECEIPTS_FIELD_INDEX = 4;

/** The receipt-retrieval surface the verifier depends on (injectable for tests). */
export interface ReceiptSource {
  count(): Promise<number | null>;
  get(index: number): Promise<Receipt | null>;
  latest(n: number): Promise<Receipt[]>;
}

/** Live AuditLog reader over a {@link ChainClient}. `contractHash` is the **active** hash. */
export class AuditLogReceiptReader implements ReceiptSource {
  private readonly countIndex: number;
  private readonly receiptsIndex: number;

  constructor(
    private readonly chain: ChainClient,
    private readonly contractHash: string,
    opts?: { countFieldIndex?: number; receiptsFieldIndex?: number },
  ) {
    this.countIndex = opts?.countFieldIndex ?? AUDITLOG_COUNT_FIELD_INDEX;
    this.receiptsIndex = opts?.receiptsFieldIndex ?? AUDITLOG_RECEIPTS_FIELD_INDEX;
  }

  async count(): Promise<number | null> {
    const bytes = await this.chain.getDictionaryBytes(
      this.contractHash,
      ODRA_STATE_DICTIONARY,
      odraDictionaryItemKey(this.countIndex),
    );
    if (!bytes) return null;
    try {
      return Number(new ByteReader(bytes).u64());
    } catch {
      return null;
    }
  }

  async get(index: number): Promise<Receipt | null> {
    const mappingKey = new ByteWriter().u64(BigInt(index)).finish();
    const bytes = await this.chain.getDictionaryBytes(
      this.contractHash,
      ODRA_STATE_DICTIONARY,
      odraDictionaryItemKey(this.receiptsIndex, mappingKey),
    );
    if (!bytes) return null;
    try {
      return parseReceipt(bytes);
    } catch {
      return null;
    }
  }

  async latest(n: number): Promise<Receipt[]> {
    const total = await this.count();
    if (total === null || total === 0) return [];
    const from = Math.max(0, total - n);
    const out: Receipt[] = [];
    for (let i = from; i < total; i++) {
      const r = await this.get(i);
      if (r) out.push(r);
    }
    return out;
  }
}
