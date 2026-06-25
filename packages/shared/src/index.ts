/**
 * @sentinel/shared — the proof contract.
 *
 * Off-chain TS types + JSON schemas + canonical-JSON blake2b hashing that must mirror
 * the on-chain `Receipt` (spec §9). The hash equality
 *   blake2b(MarketSnapshot) == Receipt.perceptionHash
 *   blake2b(Decision)       == Receipt.decisionHash
 * is what makes the AuditLog verifiable.
 */
export * from './types/onchain.js';
export * from './position.js';
export * from './types/provenance.js';
export * from './types/market.js';
export * from './types/decision.js';
export * from './hash/canonical.js';
export * from './schemas/index.js';
