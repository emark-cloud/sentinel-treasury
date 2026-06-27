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
  computeUserPosition,
  type NavSnapshot,
  type UserPosition,
  type VaultBalances,
} from '@sentinel/shared';
import { readAccountLedger, readVaultNativeMotes, stateRootHash } from './ledgerReader';

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
  /** Public node JSON-RPC endpoint for direct on-chain reads (no token needed). */
  nodeRpcUrl: string;
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
    nodeRpcUrl:
      process.env.DASHBOARD_RPC_URL ??
      process.env.NEXT_PUBLIC_NODE_RPC_URL ??
      'https://node.testnet.casper.network/rpc',
  };
}

/**
 * Resolve the vault's **package** hash to its current active **contract** hash via CSPR.cloud
 * (`/contracts?contract_package_hash=…`), choosing the highest enabled version — the upgradable
 * vault's active hash changes per redeploy, but the package hash in env is stable. Mirrors the
 * orchestrator's `CsprCloudClient.resolveContractHash`.
 */
let contractHashCache: { pkg: string; hash: string } | null = null;
async function resolveVaultContractHash(cfg: ServerConfig): Promise<string> {
  if (contractHashCache?.pkg === cfg.vaultContractHash) return contractHashCache.hash;
  const records = await getData<{ contract_hash: string; contract_version: number; is_disabled?: boolean }[]>(
    cfg,
    `/contracts?contract_package_hash=${cfg.vaultContractHash}`,
  );
  const active = (records ?? [])
    .filter((r) => !r.is_disabled)
    .sort((a, b) => b.contract_version - a.contract_version)[0];
  if (!active?.contract_hash) throw new Error(`no active contract for package ${cfg.vaultContractHash}`);
  contractHashCache = { pkg: cfg.vaultContractHash, hash: active.contract_hash };
  return active.contract_hash;
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
  // Native CSPR: the vault is a legacy `Contract`, so its CSPR sits in `__contract_main_purse`,
  // which CSPR.cloud's `/accounts/{hash}` does not expose (it reports `null`). Read the purse from
  // the node instead. CEP-18 holdings, by contrast, are keyed by the vault's package hash (Odra's
  // `self_address()` is `Address::Contract(package)`), which the `ft-token-ownership` endpoint reads.
  //
  // The contract-hash resolve (CSPR.cloud) and the state-root-hash fetch (node) are independent —
  // kick both off in parallel so the native path isn't four serial ~3s round-trips. `srh` is then
  // shared into the purse-balance read.
  const native = Promise.all([resolveVaultContractHash(cfg), stateRootHash(cfg.nodeRpcUrl)])
    .then(([contractHash, srh]) => readVaultNativeMotes(cfg.nodeRpcUrl, contractHash, srh))
    .catch(() => 0n);
  const cep18 = (pkg: string) =>
    getData<{ balance?: string }[]>(cfg, `/accounts/${cfg.vaultHash}/ft-token-ownership?contract_package_hash=${pkg}`)
      .then((rows) => BigInt(rows?.[0]?.balance ?? '0'))
      .catch(() => 0n);
  const [cspr, scspr, csprusd] = await Promise.all([native, cep18(cfg.scsprPackage), cep18(cfg.stablePackage)]);
  return { cspr: cspr.toString(), scspr: scspr.toString(), csprusd: csprusd.toString() };
}

// The aggregate TVL changes only on a deposit/withdraw/rebalance, but each cold read costs several
// serial ~3s round-trips to the public testnet RPC/CSPR.cloud endpoints (the per-call latency is
// irreducible). So we cache the snapshot with **stale-while-revalidate** semantics:
//   - fresh (< FRESH_MS): serve the cache, do nothing;
//   - stale (< MAX_MS):   serve the cache *immediately*, refresh in the background;
//   - empty/expired:      block on one upstream read (only the very first load ever waits).
// Concurrent reads coalesce onto a single in-flight upstream fetch. Net effect: the dashboard
// resolves instantly after the first load, with data at most ~FRESH_MS stale. Override via env.
const FRESH_MS = Number(process.env.DASHBOARD_VAULT_TTL_MS ?? '10000');
const MAX_MS = Number(process.env.DASHBOARD_VAULT_MAX_STALE_MS ?? '300000');
type Snapshot = { live: boolean; nav: NavSnapshot };
let snapshotCache: { at: number; value: Snapshot } | null = null;
let snapshotInflight: Promise<Snapshot> | null = null;

function refreshSnapshot(cfg: ServerConfig): Promise<Snapshot> {
  if (snapshotInflight) return snapshotInflight; // coalesce concurrent refreshes
  snapshotInflight = (async () => {
    const balances = await readBalances(cfg);
    const nav = computeNavSnapshot({ balances, twapMicros: cfg.twapMicros, rate: cfg.rate });
    const value: Snapshot = { live: true, nav };
    snapshotCache = { at: Date.now(), value };
    return value;
  })();
  // Clear the in-flight handle whether it resolves or rejects (a failed refresh keeps stale cache).
  snapshotInflight.catch(() => {}).finally(() => {
    snapshotInflight = null;
  });
  return snapshotInflight;
}

/** Whole-vault aggregate TVL snapshot. `live:false` ⇒ env not configured, caller falls back to demo. */
export async function readVaultSnapshot(): Promise<Snapshot> {
  const cfg = readConfig();
  if (!cfg) {
    return {
      live: false,
      nav: {
        totalNavUsd: '0',
        managedNavUsd: '0',
        allocBps: { scspr: 0, csprusd: 0, cspr: 0 },
        balances: { cspr: '0', scspr: '0', csprusd: '0' },
      },
    };
  }
  const age = snapshotCache ? Date.now() - snapshotCache.at : Infinity;
  if (snapshotCache && age < FRESH_MS) return snapshotCache.value;
  if (snapshotCache && age < MAX_MS) {
    void refreshSnapshot(cfg); // stale: serve now, revalidate in the background
    return snapshotCache.value;
  }
  return refreshSnapshot(cfg); // cold (first load) or too stale: block on one read
}

/**
 * A single account's position (its own ledger slice). In the multi-tenant vault this comes from the
 * contract's per-account ledger (`account_balances(account)`) — read directly from on-chain Odra
 * storage by JSON-RPC (see `ledgerReader`), not from the CSPR.cloud aggregate. Valuation (USD value
 * + allocation) is the shared pure math, kept in lock-step with the on-chain `account_value_usd` /
 * `compute_alloc`. Returns `position: null` only when the account has no chain identity (demo key)
 * or the read fails — a real account with no deposits reads as an all-zero slice.
 */
export async function readPositionFor(account: string): Promise<{ live: boolean; position: UserPosition | null }> {
  const cfg = readConfig();
  if (!cfg) return { live: false, position: null };
  const contractHash = await resolveVaultContractHash(cfg);
  const balances = await readAccountLedger(cfg.nodeRpcUrl, contractHash, account);
  if (!balances) return { live: true, position: null };
  const position = computeUserPosition(account, balances, { twapMicros: cfg.twapMicros, rate: cfg.rate });
  return { live: true, position };
}
