/**
 * Canonical-JSON + blake2b-256 hashing — the proof contract (spec §9.3, CLAUDE.md).
 *
 * `blake2b(MarketSnapshot) == Receipt.perceptionHash` and
 * `blake2b(Decision) == Receipt.decisionHash`. The hash is computed over RFC 8785
 * canonical JSON (JCS: lexicographically sorted keys, fixed ES number formatting) so
 * it is byte-for-byte reproducible across environments — the off-chain orchestrator,
 * the dashboard verifier, and any third party all derive the same digest.
 *
 * Reproducibility discipline: hashed payloads must avoid floating-point fields whose
 * value could differ by environment. On-chain amounts use decimal strings; bps use
 * integers. Floats that exist in `MarketSnapshot` (e.g. volatility) are descriptive
 * context, not consensus values — JCS still serializes them deterministically.
 */
import canonicalizeDefault from 'canonicalize';
import { blake2b } from 'blakejs';

// `canonicalize` ships CJS with an ESM-style `.d.ts`. Under NodeNext the default import
// is mistyped as the module namespace, though Node binds it to the function at runtime.
const canonicalize = canonicalizeDefault as unknown as (input: unknown) => string | undefined;

const encoder = new TextEncoder();

/**
 * RFC 8785 (JSON Canonicalization Scheme) string for `value`.
 * Throws if `value` is not JSON-serializable (e.g. contains a function or `undefined`
 * at the top level) — hashed artifacts must be plain data.
 */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) {
    throw new Error('canonicalize: value is not JSON-serializable (got undefined)');
  }
  return out;
}

/** blake2b with a 256-bit (32-byte) digest. */
export function blake2b256(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, undefined, 32);
}

/** Lowercase hex (no `0x`) for a byte array. */
export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Raw 32-byte blake2b-256 digest over the canonical JSON of `value`. */
export function hashCanonicalBytes(value: unknown): Uint8Array {
  return blake2b256(encoder.encode(canonicalJson(value)));
}

/**
 * The hashing primitive used everywhere: blake2b-256 over canonical JSON, as lowercase
 * hex (no `0x`). Matches the on-chain `[u8; 32]` perception/decision hash bytes.
 */
export function hashCanonical(value: unknown): string {
  return toHex(hashCanonicalBytes(value));
}
