/**
 * Chain client seam (spec §8.1) — the narrow surface the execution + proof layers need from a
 * Casper node, behind an interface so the loop and tests share one boundary (the same discipline
 * the Phase-3 data sources follow). The live `RpcChainClient` wraps casper-js-sdk's `RpcClient`;
 * tests inject a fake that returns scripted submit/poll results and dictionary bytes.
 */
import { RpcClient, HttpHandler } from '../casper/sdk.js';
import type { TransactionT } from '../casper/sdk.js';
import { stripBlobPrefix, hexToBytes } from './clbytes.js';

/** Finality + result of a submitted transaction, normalized across SDK shapes. */
export interface TxStatus {
  /** True once the transaction has an execution result (Zug → deterministic finality). */
  finalized: boolean;
  /** True when finalized without an error message. */
  success: boolean;
  /** Contract revert / execution error, when present. */
  errorMessage?: string;
  /** Gas consumed in motes (decimal string), when reported. */
  gasMotes?: string;
  /** Block hash the transaction was executed in, when finalized. */
  blockHash?: string;
}

export interface ChainClient {
  /** Submit a built+signed transaction; resolves to its hash hex. */
  submit(tx: TransactionT): Promise<string>;
  /** Poll a transaction by hash; `null` if the node has not seen it yet. */
  getStatus(txHash: string): Promise<TxStatus | null>;
  /**
   * Read an Odra `state`-dictionary item's raw value bytes (blob prefix stripped), or `null` if
   * absent. `contractHash` is the **active** contract hash (not the package hash).
   */
  getDictionaryBytes(
    contractHash: string,
    dictionaryName: string,
    dictionaryItemKey: string,
  ): Promise<Uint8Array | null>;
}

interface ClBytesLike {
  bytes?: string;
}

/** Live chain client over a Testnet RPC endpoint. */
export class RpcChainClient implements ChainClient {
  private readonly rpc: InstanceType<typeof RpcClient>;

  constructor(rpcUrl: string) {
    this.rpc = new RpcClient(new HttpHandler(rpcUrl, 'fetch'));
  }

  async submit(tx: TransactionT): Promise<string> {
    const res = await this.rpc.putTransaction(tx);
    return res.transactionHash.toHex();
  }

  async getStatus(txHash: string): Promise<TxStatus | null> {
    let res;
    try {
      res = await this.rpc.getTransactionByTransactionHash(txHash);
    } catch {
      return null; // not yet known to the node
    }
    const info = res.executionInfo;
    if (!info?.executionResult) return { finalized: false, success: false };
    const er = info.executionResult;
    const errorMessage =
      er.errorMessage && er.errorMessage.length > 0 ? er.errorMessage : undefined;
    return {
      finalized: true,
      success: errorMessage === undefined,
      ...(errorMessage ? { errorMessage } : {}),
      ...(er.cost !== undefined ? { gasMotes: String(er.cost) } : {}),
      ...(info.blockHash ? { blockHash: info.blockHash.toHex() } : {}),
    };
  }

  async getDictionaryBytes(
    contractHash: string,
    dictionaryName: string,
    dictionaryItemKey: string,
  ): Promise<Uint8Array | null> {
    try {
      const item = await this.rpc.getDictionaryItemByIdentifier(null, {
        contractNamedKey: {
          key: `hash-${contractHash}`,
          dictionaryName,
          dictionaryItemKey,
        },
      } as never);
      const cl = item.storedValue?.clValue as ClBytesLike | undefined;
      if (!cl?.bytes) return null;
      return stripBlobPrefix(hexToBytes(cl.bytes));
    } catch {
      return null;
    }
  }
}
