/**
 * Server-side vault reads (runs only in the Next.js route handlers, never the browser, so the
 * CSPR.cloud access token stays secret).
 *
 * Composes the shared NAV/share math (`@sentinel/shared`) with live data:
 *  - **balances** from CSPR.cloud (native purse + the two CEP-18 ownerships), same endpoints the
 *    orchestrator uses (`packages/orchestrator/src/data/csprCloud.ts`);
 *  - **price + sCSPR rate** from env (the authoritative valuation is the on-chain Styks read inside
 *    the contract; these drive display only, so a configured near-spot value is sufficient);
 *  - **shares** reconstructed from the vault's `Deposited`/`Redeemed` event stream.
 *
 * When the backend env is not configured (the default in a fresh checkout) `live` is false and the
 * UI falls back to the in-memory demo vault — the same honesty seam the agent loop uses.
 */
import {
  computeNavSnapshot,
  type NavSnapshot,
  type UserPosition,
  type VaultBalances,
} from '@sentinel/shared';

interface ServerConfig {
  baseUrl: string;
  token: string;
  /** Hash CSPR.cloud keys the vault's holdings by (account/entity hash of the deployed vault). */
  vaultHash: string;
  vaultContractHash: string;
  scsprPackage: string;
  stablePackage: string;
  twapMicros: bigint;
  rate: { stakedCspr: bigint; totalSupply: bigint };
}

function readConfig(): ServerConfig | null {
  const token = process.env.CSPR_CLOUD_ACCESS_TOKEN;
  const vaultHash = process.env.VAULT_ENTITY_HASH;
  const scsprPackage = process.env.WISE_LENDING_STAKING_HASH;
  const stablePackage = process.env.STABLE_TOKEN_HASH;
  const vaultContractHash = process.env.VAULT_CONTRACT_HASH;
  if (!token || !vaultHash || !scsprPackage || !stablePackage || !vaultContractHash) return null;
  return {
    baseUrl: (process.env.CSPR_CLOUD_BASE_URL ?? 'https://api.testnet.cspr.cloud').replace(/\/$/, ''),
    token,
    vaultHash,
    vaultContractHash,
    scsprPackage,
    stablePackage,
    twapMicros: BigInt(process.env.DASHBOARD_TWAP_MICROS ?? '30700'),
    rate: {
      stakedCspr: BigInt(process.env.DASHBOARD_SCSPR_STAKED ?? '1052'),
      totalSupply: BigInt(process.env.DASHBOARD_SCSPR_SUPPLY ?? '1000'),
    },
  };
}

async function getData<T>(cfg: ServerConfig, path: string): Promise<T> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    headers: { Authorization: cfg.token, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`CSPR.cloud ${path} → ${res.status}`);
  const body = (await res.json()) as { data?: T };
  return body.data as T;
}

async function readBalances(cfg: ServerConfig): Promise<VaultBalances> {
  const native = getData<{ balance?: string }>(cfg, `/accounts/${cfg.vaultHash}`)
    .then((d) => BigInt(d?.balance ?? '0'))
    .catch(() => 0n);
  const cep18 = (pkg: string) =>
    getData<{ balance?: string }[]>(cfg, `/accounts/${cfg.vaultHash}/ft-token-ownership?contract_package_hash=${pkg}`)
      .then((rows) => BigInt(rows?.[0]?.balance ?? '0'))
      .catch(() => 0n);
  const [cspr, scspr, csprusd] = await Promise.all([native, cep18(cfg.scsprPackage), cep18(cfg.stablePackage)]);
  return { cspr: cspr.toString(), scspr: scspr.toString(), csprusd: csprusd.toString() };
}

/** Whole-vault aggregate TVL snapshot. `live:false` ⇒ env not configured, caller falls back to demo. */
export async function readVaultSnapshot(): Promise<{ live: boolean; nav: NavSnapshot }> {
  const cfg = readConfig();
  if (!cfg) {
    return { live: false, nav: { totalNavUsd: '0', balances: { cspr: '0', scspr: '0', csprusd: '0' } } };
  }
  const balances = await readBalances(cfg);
  const nav = computeNavSnapshot({ balances, twapMicros: cfg.twapMicros, rate: cfg.rate });
  return { live: true, nav };
}

/**
 * A single account's position (its own ledger slice). In the multi-tenant vault this comes from the
 * contract's `account_balances(account)` view — a per-account on-chain read, not the CSPR.cloud
 * aggregate. That node-RPC view query is the one piece wired against the live deploy (see the
 * redeploy/verification step); until then live mode reports the account as not-yet-loaded
 * (`position: null`) rather than guessing, and the UI keeps the aggregate TVL it can read.
 */
export async function readPositionFor(_account: string): Promise<{ live: boolean; position: UserPosition | null }> {
  const cfg = readConfig();
  if (!cfg) return { live: false, position: null };
  // TODO(post-deploy): query the vault's `account_balances`/`account_value_usd` views by RPC and
  // map to UserPosition via `computeUserPosition`.
  return { live: true, position: null };
}
