/**
 * Provenance discipline (spec §5.3, CLAUDE.md) — every snapshot field is labelled so an
 * estimate is never presented as fact.
 *
 * - VERIFIED:  read directly from an authoritative on-chain/source feed (e.g. Styks TWAP).
 * - COMPUTED:  derived deterministically from verified inputs (e.g. sCSPR exchange rate
 *              = staked_cspr / total_supply; bps weights).
 * - ESTIMATED: modelled or approximate (e.g. volatility, price-impact projections).
 */
export type ProvenanceLabel = 'VERIFIED' | 'COMPUTED' | 'ESTIMATED';

/** Per-field provenance entry; `field` is a dotted path into the MarketSnapshot. */
export interface SignalProvenance {
  field: string;
  label: ProvenanceLabel;
  source: string;
}
