/**
 * On-chain reads for the perception layer (spec §5.1, §7.1).
 *
 * Two values the Scout needs from chain:
 *  - **CSPR/USD TWAP** from Styks (`get_twap_price("CSPRUSD") -> Option<U64>`), provenance
 *    VERIFIED. The same read is performed on-chain inside `execute_rebalance` for cap
 *    enforcement (D-002). Off-chain it is read for display + the decision math.
 *  - **sCSPR→CSPR exchange rate**, provenance COMPUTED = `staked_cspr()` / `total_supply()`
 *    (no getter on the Wise staking contract — D-001).
 *
 * **Styks off-chain read — RESOLVED on live Testnet (2026-06-22, D-012):** Styks is an Odra
 * contract; all its storage lives in one dictionary named `state` (the Odra `STATE_KEY`), and
 * the TWAP for a feed is the *sample ring buffer* `get_current_twap_store(id) -> List<Option<U64>>`
 * (the published price is `get_twap_price`, the **simple average** of those samples — Styks docs).
 * The dictionary item key is the Odra-derived `hex(blake2b256( u32_be(field_index) ++ CLString(id) ))`.
 * On Testnet the CSPRUSD store sits at field index 4 (`STYKS_TWAP_FIELD_INDEX`) and the last
 * heartbeat is the Odra `Var` at field index 3 (`Option<U64>`, unix **seconds**). Confirmed by a
 * live dictionary read returning `[Some(307), Some(306), Some(308)]` for `CSPRUSD`.
 *
 * **Scale — INFERRED, reconcile on-chain (D-012):** the raw Styks U64 for CSPRUSD is ~307 while
 * live CSPR/USD is ~$0.0023, so the feed carries ~5 decimals (raw/1e5 ≈ $0.00307), **not** the
 * 1e6 micro-USD the off-chain layer first assumed. `STYKS_RAW_DECIMALS` captures this; the value
 * is converted to the off-chain USD-micros denomination below. The *authoritative* number for
 * cap math remains the on-chain Styks read inside the contract (D-002), so any residual scale
 * error is caught there, not here.
 *
 * The reader is still best-effort: it returns `null` on any RPC/parse failure so the Data Service
 * can fall back to the configured/scenario feed and label provenance honestly (`fallback-spot`).
 */
import { blake2b } from '@noble/hashes/blake2b';
import { RpcClient, HttpHandler } from '../casper/sdk.js';

/** Off-chain USD denomination: micro-USD (1e6), matching the on-chain cap denomination. */
export const PRICE_SCALE = 1_000_000n;

/** Odra dictionary holding all contract storage (the `STATE_KEY`). */
const ODRA_STATE_DICTIONARY = 'state';
/** Field index of the CSPRUSD TWAP sample store on the Testnet Styks contract (live-confirmed). */
export const STYKS_TWAP_FIELD_INDEX = 4;
/** Field index of the `last_heartbeat` Var on the Testnet Styks contract (live-confirmed). */
export const STYKS_HEARTBEAT_FIELD_INDEX = 3;
/** Decimal places carried by the Styks U64 price (inferred — see module note). */
export const STYKS_RAW_DECIMALS = 5;

export interface PriceReading {
  /** TWAP in USD micros (1e6). */
  micros: bigint;
  /** Source label for provenance. */
  source: string;
}

export interface ExchangeRateInputs {
  /** Total CSPR backing the sCSPR supply (U512 base units, motes). */
  stakedCspr: bigint;
  /** sCSPR total supply (U256 base units, 9 decimals). */
  totalSupply: bigint;
}

/** CSPR/USD TWAP source (VERIFIED when from Styks). */
export interface PriceFeed {
  readTwap(): Promise<PriceReading | null>;
  /** Last Styks heartbeat (unix seconds) for the staleness guard (spec §8); null if unknown. */
  readHeartbeat(): Promise<number | null>;
}

/** sCSPR exchange-rate source (COMPUTED). */
export interface ExchangeRateFeed {
  readExchangeRate(): Promise<ExchangeRateInputs | null>;
}

/** Construct an `RpcClient` over the given Testnet RPC endpoint. */
export function makeRpcClient(rpcUrl: string): InstanceType<typeof RpcClient> {
  return new RpcClient(new HttpHandler(rpcUrl, 'fetch'));
}

/** CLString to-bytes (Casper): u32 LE length prefix + utf8 bytes. */
function clString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + utf8.length);
  new DataView(out.buffer).setUint32(0, utf8.length, true);
  out.set(utf8, 4);
  return out;
}

/** u32 big-endian — Odra's legacy index encoding for a single top-level field (index ≤ 15). */
function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Odra dictionary item key for a storage field: `hex(blake2b256(index_bytes ++ mapping_data))`,
 * where `index_bytes` is the big-endian packed field path and `mapping_data` is the serialized
 * `Mapping` key (empty for a plain `Var`). Mirrors `odra-core` `ContractEnv::current_key`.
 */
export function odraDictionaryItemKey(fieldIndex: number, mappingKey?: Uint8Array): string {
  const idx = u32be(fieldIndex);
  const input = mappingKey ? new Uint8Array([...idx, ...mappingKey]) : idx;
  return toHex(blake2b(input, { dkLen: 32 }));
}

interface ClValueNumericLike {
  toString(): string;
}
interface ClValueLike {
  ui64?: ClValueNumericLike;
  ui256?: ClValueNumericLike;
  ui512?: ClValueNumericLike;
  /** Raw serialized bytes (hex) of the stored value, when the SDK exposes them. */
  bytes?: string;
  option?: { inner: ClValueLike | null };
}

function numericToBigint(v: ClValueNumericLike | undefined): bigint | null {
  if (v === undefined) return null;
  try {
    return BigInt(v.toString());
  } catch {
    return null;
  }
}

/**
 * Parse the Styks `List<Option<U64>>` sample buffer from its raw serialized bytes and return the
 * simple average of the present (`Some`) samples — exactly what `get_twap_price` publishes. The
 * dictionary stores it CLType `List<U8>` (an Odra blob), so `bytes` may carry a 4-byte outer
 * `List<U8>` length prefix that we skip before reading the inner `List<Option<U64>>`.
 */
export function averageTwapFromBytes(hex: string): bigint | null {
  const raw = hexToBytes(hex);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let off = 0;
  const outerLen = dv.getUint32(off, true);
  // If the first u32 equals the remaining byte count, it's the List<U8> blob length prefix.
  if (outerLen === raw.length - 4) off += 4;
  const count = dv.getUint32(off, true);
  off += 4;
  let sum = 0n;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const tag = raw[off];
    off += 1;
    if (tag === 1) {
      const v = dv.getBigUint64(off, true);
      off += 8;
      sum += v;
      n += 1;
    }
  }
  if (n === 0) return null;
  return sum / BigInt(n);
}

/**
 * RPC-backed reader using casper-js-sdk. The contract hash is the **active** Styks contract hash
 * (resolve package→contract via CSPR.cloud and pass it here; upgradable contracts change their
 * active hash — abi-spike.md). Note: a token-gated RPC (cspr.cloud) needs the access token on the
 * HTTP handler; the public node (`node.testnet.casper.network/rpc`) needs none.
 */
export class RpcOnChainReader implements PriceFeed, ExchangeRateFeed {
  private readonly rpc: InstanceType<typeof RpcClient>;
  private readonly twapFieldIndex: number;
  private readonly heartbeatFieldIndex: number;

  constructor(
    rpcUrl: string,
    private readonly contracts: {
      styks: string;
      staking: string;
      /** CSPRUSD feed id and (optional) field-index overrides for the Styks Odra storage. */
      twapFeedId?: string;
      twapFieldIndex?: number;
      heartbeatFieldIndex?: number;
    },
  ) {
    this.rpc = makeRpcClient(rpcUrl);
    this.twapFieldIndex = contracts.twapFieldIndex ?? STYKS_TWAP_FIELD_INDEX;
    this.heartbeatFieldIndex = contracts.heartbeatFieldIndex ?? STYKS_HEARTBEAT_FIELD_INDEX;
  }

  /** Read a `Var`/named-key numeric (U64/U256/U512) under a contract; null on any failure. */
  private async readNamedNumeric(contractHash: string, path: string[]): Promise<bigint | null> {
    try {
      const res = await this.rpc.queryLatestGlobalState(`hash-${contractHash}`, path);
      const cl = res.storedValue?.clValue as ClValueLike | undefined;
      if (!cl) return null;
      const direct = numericToBigint(cl.ui512 ?? cl.ui256 ?? cl.ui64);
      if (direct !== null) return direct;
      if (cl.option && cl.option.inner) {
        const inner = cl.option.inner;
        return numericToBigint(inner.ui64 ?? inner.ui256 ?? inner.ui512);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Read an Odra `state`-dictionary item under the Styks contract by field index + mapping key. */
  private async readStateDictionary(
    fieldIndex: number,
    mappingKey?: Uint8Array,
  ): Promise<ClValueLike | null> {
    try {
      const itemKey = odraDictionaryItemKey(fieldIndex, mappingKey);
      const item = await this.rpc.getDictionaryItemByIdentifier(null, {
        contractNamedKey: {
          key: `hash-${this.contracts.styks}`,
          dictionaryName: ODRA_STATE_DICTIONARY,
          dictionaryItemKey: itemKey,
        },
      } as never);
      return (item.storedValue?.clValue as ClValueLike | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async readTwap(): Promise<PriceReading | null> {
    const feedId = this.contracts.twapFeedId ?? 'CSPRUSD';
    const cl = await this.readStateDictionary(this.twapFieldIndex, clString(feedId));
    if (!cl?.bytes) return null;
    const rawTwap = averageTwapFromBytes(cl.bytes);
    if (rawTwap === null) return null;
    // Convert the Styks raw integer (STYKS_RAW_DECIMALS places) to USD micros (1e6).
    const micros = (rawTwap * PRICE_SCALE) / 10n ** BigInt(STYKS_RAW_DECIMALS);
    return { micros, source: 'styks-rpc' };
  }

  async readHeartbeat(): Promise<number | null> {
    const cl = await this.readStateDictionary(this.heartbeatFieldIndex);
    if (!cl?.bytes) return null;
    // Stored as Option<U64> serialized in a List<U8> blob: [u32 blobLen]? [tag][u64 LE].
    const raw = hexToBytes(cl.bytes);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let off = 0;
    if (dv.getUint32(0, true) === raw.length - 4) off += 4;
    const tag = raw[off];
    off += 1;
    if (tag !== 1) return null;
    return Number(dv.getBigUint64(off, true)); // unix seconds
  }

  async readExchangeRate(): Promise<ExchangeRateInputs | null> {
    const stakedCspr = await this.readNamedNumeric(this.contracts.staking, ['staked_cspr']);
    const totalSupply = await this.readNamedNumeric(this.contracts.staking, ['total_supply']);
    if (stakedCspr === null || totalSupply === null || totalSupply === 0n) return null;
    return { stakedCspr, totalSupply };
  }
}

/**
 * Static / scenario price feed. Doubles as (a) the fallback when Styks isn't readable off-chain
 * and (b) the spec §15.3 demo scenario-injection mechanism — the *market event* is injected
 * here, clearly labelled; everything downstream stays real. The honesty rule: when this feed is
 * the live source, the Scout labels the price provenance with the configured `source` (e.g.
 * `scenario-injection`), never as a Styks VERIFIED read.
 */
export class StaticPriceFeed implements PriceFeed {
  constructor(
    private twapMicros: bigint,
    private readonly source = 'scenario-injection',
    private heartbeat: number | null = Math.floor(Date.now() / 1000),
  ) {}

  /** Override the injected price (demo scenario control). */
  setTwapMicros(micros: bigint, heartbeat = Math.floor(Date.now() / 1000)): void {
    this.twapMicros = micros;
    this.heartbeat = heartbeat;
  }

  readTwap(): Promise<PriceReading | null> {
    return Promise.resolve({ micros: this.twapMicros, source: this.source });
  }

  readHeartbeat(): Promise<number | null> {
    return Promise.resolve(this.heartbeat);
  }
}

/** Static exchange rate (fallback / tests). */
export class StaticExchangeRateFeed implements ExchangeRateFeed {
  constructor(private readonly inputs: ExchangeRateInputs) {}
  readExchangeRate(): Promise<ExchangeRateInputs | null> {
    return Promise.resolve(this.inputs);
  }
}

/** sCSPR→CSPR rate as a float (CSPR per sCSPR). Both balances are motes/base units so the ratio
 * is dimensionless given equal 9-decimal scaling (sCSPR=9, CSPR motes=9). */
export function exchangeRateToFloat(inputs: ExchangeRateInputs): number {
  if (inputs.totalSupply === 0n) return 1;
  const scaled = (inputs.stakedCspr * 1_000_000_000n) / inputs.totalSupply;
  return Number(scaled) / 1e9;
}
