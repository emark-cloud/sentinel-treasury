/**
 * Depositor enumeration for the multi-tenant runner — answers "whose ledgers should the agent
 * iterate this batch?" and assembles each one's {@link AccountContext} (balances + policy).
 *
 * Three sources, combined and deduped so the runner is never blocked on any single one:
 *  1. an **env seed** (`RUNNER_ACCOUNTS`) of known depositors (account hashes or public keys);
 *  2. a **persisted registry** (every depositor ever seen — survives restarts);
 *  3. **best-effort discovery** from the vault's `Deposited` events via CSPR.cloud.
 *
 * Balances are read from the per-account on-chain views (`readAccountLedger`) — authoritative, never
 * event replay. The policy applied off-chain is the configured **envelope**; the contract still
 * enforces each account's own effective (envelope-clamped) policy on-chain, so off-chain sizing can
 * never push a real action outside an account's bounds (spec §11 — guardrails below the agent).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChainClient } from '../execution/chainClient.js';
import type { CsprCloudClient } from '../data/csprCloud.js';
import type { AccountContext } from '../loop.js';
import type { DecisionPolicy } from '../decision/types.js';
import { readAccountLedger, toAccountHashHex } from './accountLedgerReader.js';

/** A persistent set of depositor account-hash-hex strings (one JSON array file). */
export class DepositorRegistry {
  private readonly hashes = new Set<string>();

  constructor(private readonly filePath: string) {}

  /** Load prior registry from disk (best-effort) and merge an env/seed list. */
  async load(seed: string[] = []): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed)) for (const h of parsed) this.add(h);
    } catch {
      // No prior registry — start from the seed only.
    }
    for (const s of seed) this.add(s);
  }

  /** Add an account (hash or public key); normalized to a 64-hex account hash. Returns true if new. */
  add(account: string): boolean {
    const hash = toAccountHashHex(account);
    if (!hash || this.hashes.has(hash)) return false;
    this.hashes.add(hash);
    return true;
  }

  all(): string[] {
    return [...this.hashes];
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.all()), 'utf8');
  }
}

export interface AccountSourceDeps {
  chain: ChainClient;
  csprCloud: CsprCloudClient;
  registry: DepositorRegistry;
  /** Vault **package** hash (resolved to the active contract hash for ledger reads). */
  vaultPackageHash: string;
  /** Configured guardrail envelope, applied as each account's decision policy. */
  policy: DecisionPolicy;
  /** Drop accounts whose ledger is entirely empty (redeemed/never funded) — nothing to manage. */
  skipEmpty?: boolean;
}

/** True when every bucket of a ledger slice is zero. */
function isEmpty(b: { cspr: string; scspr: string; csprusd: string }): boolean {
  return b.cspr === '0' && b.scspr === '0' && b.csprusd === '0';
}

/**
 * Discover + assemble the depositor contexts to run this batch. Discovery augments the registry
 * (best-effort) before reading each account's on-chain ledger slice.
 */
export class AccountSource {
  constructor(private readonly deps: AccountSourceDeps) {}

  async listAccounts(): Promise<AccountContext[]> {
    // 1. Augment the registry with any newly-discovered depositors (best-effort), then persist.
    const discovered = await this.deps.csprCloud.listDepositorAccountHashes(
      this.deps.vaultPackageHash,
    );
    let changed = false;
    for (const h of discovered) changed = this.deps.registry.add(h) || changed;
    if (changed) await this.deps.registry.persist();

    // 2. Resolve the active contract hash once, then read every account's ledger in parallel.
    const contractHash = await this.deps.csprCloud.resolveContractHash(this.deps.vaultPackageHash);
    const accounts = this.deps.registry.all();
    const contexts = await Promise.all(
      accounts.map(async (accountHashHex) => {
        const balances = await readAccountLedger(this.deps.chain, contractHash, accountHashHex);
        if (!balances) return null;
        if (this.deps.skipEmpty && isEmpty(balances)) return null;
        const ctx: AccountContext = { accountHashHex, balances, policy: this.deps.policy };
        return ctx;
      }),
    );
    return contexts.filter((c): c is AccountContext => c !== null);
  }
}
