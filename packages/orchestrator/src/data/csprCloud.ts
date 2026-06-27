/**
 * CSPR.cloud REST client (spec §5.1, resources.md §5) — vault balances + package→contract
 * resolution + recent deploys. All endpoints require the `Authorization: <access-token>` header.
 *
 * Upgradable contracts change their active contract hash, so config binds to **package** hashes;
 * this client resolves package → active contract hash at runtime where a contract hash is needed.
 *
 * Response shapes below were confirmed against the live Testnet API (`api.testnet.cspr.cloud`,
 * 2026-06-21 — D-012 validation), not guessed:
 *  - every endpoint wraps its body in `{ data, item_count?, page_count? }`;
 *  - package→contract resolution is `/contracts?contract_package_hash=…` (the
 *    `/contract-packages/{h}` record does **not** carry the active contract hash);
 *  - CEP-18 balances come from `/accounts/{accountHash}/ft-token-ownership?contract_package_hash=…`
 *    (keyed by **account hash + package hash**, returns an array), not a per-contract balance path;
 *  - the deploys feed is keyed by **public key** (`/accounts/{publicKey}/deploys`), not account hash.
 */
import type { VaultBalances } from '@sentinel/shared';

export interface CsprCloudClientOptions {
  baseUrl: string;
  accessToken: string;
  /** Injectable fetch for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Recent on-chain deploy touching the account (for the dashboard feed + reconciliation). */
export interface VaultEvent {
  deployHash: string;
  timestamp: string;
  /** Execution status reported by CSPR.cloud, e.g. `processed`. */
  status: string;
  /** Non-null when the deploy reverted. */
  errorMessage: string | null;
}

/** Active-contract record from `/contracts?contract_package_hash=…`. */
interface ContractRecord {
  contract_hash: string;
  contract_version: number;
  is_disabled: boolean;
}

/**
 * Pull a depositor account hash out of a decoded CSPR.cloud event row, tolerant of shape: the
 * `depositor` field may sit under `data`/`args`, be tagged `account-hash-…`, or be a bare 64-hex.
 * Returns a lowercase 64-hex account hash, or null when no recognizable hash is present.
 */
function extractAccountHash(row: Record<string, unknown>): string | null {
  const data = (row.data ?? row.args ?? row) as Record<string, unknown>;
  const raw = data.depositor ?? data.account ?? row.depositor;
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().toLowerCase().replace(/^0x/, '').replace(/^account-hash-/, '');
  return /^[0-9a-f]{64}$/.test(clean) ? clean : null;
}

export class CsprCloudClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly contractHashCache = new Map<string, string>();

  constructor(opts: CsprCloudClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** GET a path, unwrapping the `{ data }` envelope every CSPR.cloud endpoint uses. */
  private async getData<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Authorization: this.token, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`CSPR.cloud ${path} → HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data?: T };
    return body.data as T;
  }

  /**
   * Resolve a contract **package** hash to its current active contract hash via
   * `/contracts?contract_package_hash=…`, choosing the highest enabled `contract_version`.
   * Cached per process (invalidate on a known upgrade).
   */
  async resolveContractHash(packageHash: string): Promise<string> {
    const cached = this.contractHashCache.get(packageHash);
    if (cached) return cached;
    const records = await this.getData<ContractRecord[]>(
      `/contracts?contract_package_hash=${packageHash}`,
    );
    const active = (records ?? [])
      .filter((r) => !r.is_disabled)
      .sort((a, b) => b.contract_version - a.contract_version)[0];
    const hash = active?.contract_hash;
    if (!hash) throw new Error(`no active contract for package ${packageHash}`);
    this.contractHashCache.set(packageHash, hash);
    return hash;
  }

  /** Native CSPR balance (motes) of an account, by account-hash key. */
  async nativeBalanceMotes(accountHashHex: string): Promise<bigint> {
    const data = await this.getData<{ balance?: string }>(`/accounts/${accountHashHex}`);
    return BigInt(data?.balance ?? '0');
  }

  /**
   * CEP-18 balance (base units) held by `ownerHashHex` (account or contract hash) for the token
   * identified by its **package** hash. Returns 0 when the owner holds none (empty `data` array).
   */
  async cep18Balance(tokenPackageHash: string, ownerHashHex: string): Promise<bigint> {
    const rows = await this.getData<{ balance?: string }[]>(
      `/accounts/${ownerHashHex}/ft-token-ownership?contract_package_hash=${tokenPackageHash}`,
    );
    const bal = rows?.[0]?.balance;
    return BigInt(bal ?? '0');
  }

  /**
   * Discover the live depositor set from the vault's `Deposited` events (spec §4 multi-tenant
   * model; `onchain.ts` notes events are used only to *find which accounts to manage* — balances
   * come from the per-account contract views, never event replay).
   *
   * Best-effort, like the Styks reader was before D-012: the CSPR.cloud contract-events shape must
   * be confirmed live, so any failure or unexpected shape yields `[]` and the runner falls back to
   * its persisted registry + the env account seed. Returns distinct 64-hex account hashes.
   */
  async listDepositorAccountHashes(vaultPackageHash: string, limit = 250): Promise<string[]> {
    try {
      const rows = await this.getData<Record<string, unknown>[]>(
        `/contract-packages/${vaultPackageHash}/events?event_name=Deposited&page=1&limit=${limit}`,
      );
      const out = new Set<string>();
      for (const row of rows ?? []) {
        const hash = extractAccountHash(row);
        if (hash) out.add(hash);
      }
      return [...out];
    } catch {
      return [];
    }
  }

  /**
   * Most recent deploys made by the account (dashboard feed; spec §10). Keyed by **public key**
   * (the endpoint rejects an account hash with `failed to parse public_key`).
   */
  async recentEvents(publicKeyHex: string, limit = 10): Promise<VaultEvent[]> {
    const rows = await this.getData<
      { deploy_hash: string; timestamp: string; status?: string; error_message?: string | null }[]
    >(`/accounts/${publicKeyHex}/deploys?page=1&limit=${limit}`);
    return (rows ?? []).map((d) => ({
      deployHash: d.deploy_hash,
      timestamp: d.timestamp,
      status: d.status ?? 'unknown',
      errorMessage: d.error_message ?? null,
    }));
  }
}

/** Reads the three managed balances of the vault into the shared `VaultBalances` shape. */
export interface BalanceReader {
  readVaultBalances(): Promise<VaultBalances>;
}

/**
 * CSPR.cloud-backed vault balance reader. The native purse balance is keyed by the vault's
 * `accountHashHex`; CEP-18 balances are keyed by the same owner hash + each token's **package**
 * hash (the `ft-token-ownership` endpoint takes package hashes directly, so no contract-hash
 * resolution is needed for balances).
 */
export class CsprCloudBalanceReader implements BalanceReader {
  constructor(
    private readonly client: CsprCloudClient,
    private readonly tokens: { scsprPackage: string; stablePackage: string },
    private readonly vault: { accountHashHex: string },
  ) {}

  async readVaultBalances(): Promise<VaultBalances> {
    const [cspr, scspr, csprusd] = await Promise.all([
      this.client.nativeBalanceMotes(this.vault.accountHashHex).catch(() => 0n),
      this.client.cep18Balance(this.tokens.scsprPackage, this.vault.accountHashHex).catch(() => 0n),
      this.client
        .cep18Balance(this.tokens.stablePackage, this.vault.accountHashHex)
        .catch(() => 0n),
    ]);
    return { cspr: cspr.toString(), scspr: scspr.toString(), csprusd: csprusd.toString() };
  }
}

/** Static balances for tests / scenario harness. */
export class StaticBalanceReader implements BalanceReader {
  constructor(private readonly balances: VaultBalances) {}
  readVaultBalances(): Promise<VaultBalances> {
    return Promise.resolve(this.balances);
  }
}
