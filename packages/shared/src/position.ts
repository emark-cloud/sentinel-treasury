/**
 * NAV / share-position math for the share-issuing vault (spec §4 depositor flow). Lives in
 * `@sentinel/shared` because it is consumed on both sides of the boundary: the orchestrator
 * (`data/positionReader`) and the dashboard (server-side position API) must agree byte-for-byte
 * with what the contract does on-chain (`vault.rs` `bucket_usd` / `total_nav_usd` / `redeem`), so
 * the value a depositor sees equals what an in-kind `redeem` would actually pay out.
 *
 * All USD values are micro-USD (1e6 = $1), matching the on-chain cap denomination; balances are
 * base-unit decimal strings. Shares are integer counts (minted 1:1 with micro-USD on the first
 * deposit), so the share-price index is pegged to 1.000000 at genesis and tracks realized P&L.
 */
import type { NavSnapshot, UserPosition, VaultBalances, DepositedEvent, RedeemedEvent } from './types/onchain.js';

/** Motes / sCSPR base-unit scale (9 decimals). */
const CSPR_SCALE = 1_000_000_000n;
/** Micro-USD scale (1e6 = $1) — the share-price index is reported at this precision. */
const USD_SCALE = 1_000_000n;

type Numeric = string | bigint;
const big = (v: Numeric): bigint => (typeof v === 'bigint' ? v : BigInt(v));

/** Live sCSPR→CSPR rate inputs (`staked_cspr` / `total_supply`), as read from the staking contract. */
export interface ExchangeRate {
  stakedCspr: Numeric;
  totalSupply: Numeric;
}

/** Inputs needed to value the vault, mirroring the on-chain `bucket_usd` read. */
export interface NavInputs {
  balances: VaultBalances;
  /** CSPR/USD TWAP in micro-USD per CSPR. */
  twapMicros: Numeric;
  rate: ExchangeRate;
  /** Total shares outstanding (the redemption denominator). */
  totalShares: Numeric;
}

/** Micro-USD value of `motes` native CSPR at the given TWAP. */
function csprMotesToUsd(motes: bigint, twapMicros: bigint): bigint {
  return (motes * twapMicros) / CSPR_SCALE;
}

/**
 * The three buckets in micro-USD, exactly as the contract computes them: sCSPR → CSPR-equivalent
 * at the live rate → USD; stable is already micro-USD; CSPR via TWAP.
 */
export function bucketUsd(input: NavInputs): { scspr: bigint; csprusd: bigint; cspr: bigint } {
  const twap = big(input.twapMicros);
  const scsprBal = big(input.balances.scspr);
  const csprusdBal = big(input.balances.csprusd);
  const csprMotes = big(input.balances.cspr);
  const staked = big(input.rate.stakedCspr);
  const supply = big(input.rate.totalSupply);

  const scsprCsprEquiv = supply === 0n ? 0n : (scsprBal * staked) / supply;
  return {
    scspr: csprMotesToUsd(scsprCsprEquiv, twap),
    csprusd: csprusdBal, // 6-decimal stable ≈ micro-USD
    cspr: csprMotesToUsd(csprMotes, twap),
  };
}

/** Assemble the whole-vault NAV/share snapshot. */
export function computeNavSnapshot(input: NavInputs): NavSnapshot {
  const buckets = bucketUsd(input);
  const totalNavUsd = buckets.scspr + buckets.csprusd + buckets.cspr;
  const totalShares = big(input.totalShares);
  // Share-price index scaled to 1e6 (1.000000 at genesis; grows with yield, falls with drawdown).
  const navPerShareMicros = totalShares === 0n ? USD_SCALE : (totalNavUsd * USD_SCALE) / totalShares;
  return {
    totalNavUsd: totalNavUsd.toString(),
    totalShares: totalShares.toString(),
    navPerShareMicros: navPerShareMicros.toString(),
    balances: input.balances,
  };
}

/**
 * A single account's position: USD value, % of pool, and the in-kind asset slice an immediate
 * `redeem(shares)` would pay out (pro-rata of every bucket — what the contract actually transfers).
 */
export function computeUserPosition(account: string, shares: Numeric, nav: NavSnapshot): UserPosition {
  const sh = big(shares);
  const totalShares = big(nav.totalShares);
  const totalNavUsd = big(nav.totalNavUsd);
  if (totalShares === 0n || sh === 0n) {
    return {
      account,
      shares: sh.toString(),
      valueUsd: '0',
      pctOfPoolBps: 0,
      assetBreakdown: { cspr: '0', scspr: '0', csprusd: '0' },
    };
  }
  const slice = (bal: string): string => ((big(bal) * sh) / totalShares).toString();
  return {
    account,
    shares: sh.toString(),
    valueUsd: ((totalNavUsd * sh) / totalShares).toString(),
    pctOfPoolBps: Number((sh * 10_000n) / totalShares),
    assetBreakdown: {
      cspr: slice(nav.balances.cspr),
      scspr: slice(nav.balances.scspr),
      csprusd: slice(nav.balances.csprusd),
    },
  };
}

/**
 * Shares minted for a `depositUsdMicros` contribution to a pool worth `navBeforeMicros` with
 * `supply` shares outstanding — the exact rule the contract applies (`vault.rs` `shares_to_mint`).
 * The first deposit (empty supply or empty pool) mints 1 share per micro-USD; thereafter the mint
 * is diluted by live NAV so every depositor's entry price is consistent.
 */
export function sharesForDeposit(depositUsdMicros: Numeric, navBeforeMicros: Numeric, supply: Numeric): bigint {
  const deposit = big(depositUsdMicros);
  const before = big(navBeforeMicros);
  const sup = big(supply);
  if (sup === 0n || before === 0n) return deposit;
  return (deposit * sup) / before;
}

// --------------------------------------------------------------------- share ledger

/** Per-account share balances + the outstanding supply (the authoritative redemption ledger). */
export interface ShareLedger {
  totalShares(): bigint;
  sharesOf(account: string): bigint;
}

/** Source of the vault's share-changing events (CSPR.cloud event stream, or a fixture in tests). */
export interface ShareEventSource {
  deposits(): Promise<DepositedEvent[]>;
  redeems(): Promise<RedeemedEvent[]>;
}

/** Normalize an address key so `depositor`/`redeemer` from events match a queried account. */
export function normalizeAccount(account: string): string {
  return account.trim().toLowerCase().replace(/^0x/, '');
}

/**
 * Reconstruct the share ledger by replaying the vault's events: shares are minted only by
 * `Deposited` and burned only by `Redeemed`, so the running sum per account is exact — no need
 * to crack open Odra's internal storage layout.
 */
export async function buildShareLedger(source: ShareEventSource): Promise<ShareLedger> {
  const balances = new Map<string, bigint>();
  let supply = 0n;

  for (const d of await source.deposits()) {
    const key = normalizeAccount(d.depositor);
    const minted = big(d.sharesMinted);
    balances.set(key, (balances.get(key) ?? 0n) + minted);
    supply += minted;
  }
  for (const r of await source.redeems()) {
    const key = normalizeAccount(r.redeemer);
    const burned = big(r.sharesBurned);
    balances.set(key, (balances.get(key) ?? 0n) - burned);
    supply -= burned;
  }

  return {
    totalShares: () => supply,
    sharesOf: (account: string) => balances.get(normalizeAccount(account)) ?? 0n,
  };
}

/** Static ledger for tests / fixtures. */
export class StaticShareLedger implements ShareLedger {
  constructor(
    private readonly supply: bigint,
    private readonly byAccount: Record<string, bigint>,
  ) {}
  totalShares(): bigint {
    return this.supply;
  }
  sharesOf(account: string): bigint {
    return this.byAccount[normalizeAccount(account)] ?? 0n;
  }
}

/**
 * Top-level convenience: given the vault's balances + price/rate + a reconstructed ledger, return
 * the whole-vault snapshot and (optionally) a specific account's position in one shot.
 */
export function readPositions(
  navInputs: Omit<NavInputs, 'totalShares'>,
  ledger: ShareLedger,
  account?: string,
): { nav: NavSnapshot; position: UserPosition | null } {
  const nav = computeNavSnapshot({ ...navInputs, totalShares: ledger.totalShares() });
  const position = account ? computeUserPosition(account, ledger.sharesOf(account), nav) : null;
  return { nav, position };
}
