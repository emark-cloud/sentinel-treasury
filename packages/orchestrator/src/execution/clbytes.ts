/**
 * Casper `bytesrepr` + Odra serialization primitives (spec §8.1).
 *
 * The Phase-5 execution layer calls the vault's `execute_rebalance(params: RebalanceParams)`
 * over casper-js-sdk. `RebalanceParams` is an `#[odra::odra_type]` struct, and the proof layer
 * reads back `Receipt` from the AuditLog Odra storage — both need byte-exact (de)serialization
 * matching what the contract's `ToBytes`/`FromBytes` produce. casper-js-sdk has no generic
 * struct codec, so we encode the struct bytes here and wrap them in `CLValue.newCLAny(...)`:
 * Odra reads a named arg as the CLValue's raw value bytes and applies `FromBytes`, so the
 * declared CLType (`Any`) is irrelevant — only these bytes must match.
 *
 * Confirmed against the contract crates (D-009 build):
 *  - unit enums (`ActionKind`/`Regime`/`Asset`) → a single `u8` variant index (odra-macros 2.8);
 *  - structs → fields concatenated in declaration order;
 *  - `U256`/`U512` → 1 length byte (# of non-zero LE bytes) + that many LE bytes;
 *  - `u64`/`u32` → fixed little-endian; `[u8; 32]` → 32 raw bytes (no length prefix);
 *  - `Address` → `Key` bytes: `Account` = `0x00 ++ 32`, `Contract` = `Key::Hash` = `0x01 ++ 32`
 *    (casper-types `KeyTag::Account=0`, `Hash=1`);
 *  - `Vec<T>` → `u32` LE count + each element.
 */

/** Casper `Key` tag for an account address. */
export const KEY_TAG_ACCOUNT = 0;
/** Casper `Key` tag for a contract (`Key::Hash`) address — what `Address::Contract` maps to. */
export const KEY_TAG_HASH = 1;

/** Append-only byte writer producing a `Uint8Array` in casper `bytesrepr` order. */
export class ByteWriter {
  private chunks: number[] = [];

  u8(n: number): this {
    this.chunks.push(n & 0xff);
    return this;
  }

  u32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return this.raw(b);
  }

  u64(n: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return this.raw(b);
  }

  /** Casper `U256`/`U512`: length-prefixed minimal little-endian bytes. */
  uint(value: bigint): this {
    if (value < 0n) throw new Error(`cannot serialize negative integer: ${value}`);
    const bytes: number[] = [];
    let v = value;
    while (v > 0n) {
      bytes.push(Number(v & 0xffn));
      v >>= 8n;
    }
    this.u8(bytes.length);
    for (const b of bytes) this.chunks.push(b);
    return this;
  }

  /** Raw bytes, no length prefix (fixed arrays like `[u8; 32]`). */
  raw(bytes: Uint8Array): this {
    for (const b of bytes) this.chunks.push(b);
    return this;
  }

  /** A 32-byte fixed array from lowercase hex. */
  bytes32(hex: string): this {
    const b = hexToBytes(hex);
    if (b.length !== 32) throw new Error(`expected 32-byte hex, got ${b.length} bytes`);
    return this.raw(b);
  }

  /** Odra `Address` for a contract package hash (`Key::Hash`). */
  contractAddress(packageHashHex: string): this {
    return this.u8(KEY_TAG_HASH).bytes32(packageHashHex);
  }

  /** Odra `Address` for an account hash (`Key::Account`). */
  accountAddress(accountHashHex: string): this {
    return this.u8(KEY_TAG_ACCOUNT).bytes32(accountHashHex);
  }

  /** `Vec<T>`: a u32 count followed by each element, encoded by `enc`. */
  vec<T>(items: readonly T[], enc: (w: ByteWriter, item: T) => void): this {
    this.u32(items.length);
    for (const item of items) enc(this, item);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/** Sequential reader mirroring {@link ByteWriter} for parsing stored Odra values. */
export class ByteReader {
  private off = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number {
    return this.off;
  }

  get remaining(): number {
    return this.bytes.length - this.off;
  }

  u8(): number {
    const v = this.bytes[this.off];
    if (v === undefined) throw new Error('ByteReader: out of bounds reading u8');
    this.off += 1;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  u64(): bigint {
    const v = this.view.getBigUint64(this.off, true);
    this.off += 8;
    return v;
  }

  /** Casper `U256`/`U512`: length byte then that many LE bytes. */
  uint(): bigint {
    const len = this.u8();
    let v = 0n;
    for (let i = 0; i < len; i++) {
      v |= BigInt(this.u8()) << (8n * BigInt(i));
    }
    return v;
  }

  raw(n: number): Uint8Array {
    const out = this.bytes.subarray(this.off, this.off + n);
    if (out.length !== n) throw new Error(`ByteReader: out of bounds reading ${n} bytes`);
    this.off += n;
    return out;
  }

  bytes32Hex(): string {
    return bytesToHex(this.raw(32));
  }

  /** Odra `Address`: 1 tag byte + 32 bytes. Returns the 32-byte body hex and its key tag. */
  address(): { tag: number; hex: string } {
    const tag = this.u8();
    return { tag, hex: this.bytes32Hex() };
  }

  vec<T>(dec: (r: ByteReader) => T): T[] {
    const len = this.u32();
    const out: T[] = [];
    for (let i = 0; i < len; i++) out.push(dec(this));
    return out;
  }
}

/**
 * Some Odra-stored values arrive wrapped as a `List<U8>` blob — a 4-byte length prefix whose
 * value equals the remaining byte count. Strip it so the inner `bytesrepr` value can be read.
 * (Matches the heartbeat/TWAP handling in `data/onchainReader.ts`.)
 */
export function stripBlobPrefix(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4) return bytes;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  return len === bytes.length - 4 ? bytes.subarray(4) : bytes;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
