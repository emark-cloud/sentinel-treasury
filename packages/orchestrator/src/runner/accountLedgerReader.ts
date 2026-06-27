/**
 * Per-account ledger reader (runner side) — reads a depositor's own on-chain ledger slice
 * (`account_balances(account)`) so the agent can size a cycle against *their* holdings, not the
 * vault aggregate.
 *
 * The multi-tenant vault credits each depositor in three `Mapping<Address, U256>` fields
 * (`cspr_of` / `scspr_of` / `csprusd_of`). Their Odra dictionary item key is
 * `hex(blake2b256( u32_be(field_index) ++ Key::Account ))`, where the field index is the **1-based**
 * struct position and the map key is the Casper `Key` for the account (tag `0x00` ++ 32-byte hash).
 * Verified byte-for-byte against the live D-015 deploy (see the dashboard's `ledgerReader`, which
 * uses the same layout). Reads go through the {@link ChainClient} seam so tests inject a fake.
 */
import type { VaultBalances } from '@sentinel/shared';
import { PublicKey } from '../casper/sdk.js';
import type { ChainClient } from '../execution/chainClient.js';
import { ByteReader, ByteWriter } from '../execution/clbytes.js';
import { odraDictionaryItemKey } from '../data/onchainReader.js';

const ODRA_STATE_DICTIONARY = 'state';

/**
 * 1-based field indices of the per-account ledger mappings in `SentinelVault` storage (declaration
 * order: owner, agent, paused, per_action_cap_usd, daily_cap_usd, max_slippage_bps, min_scspr_bps,
 * max_scspr_bps, whitelist, audit_log, action_nonce, **cspr_of, scspr_of, csprusd_of**, …).
 */
export const LEDGER_FIELD_INDEX = { cspr: 12, scspr: 13, csprusd: 14 } as const;

/**
 * Normalize an account reference to its 32-byte account-hash hex. Accepts a Casper public-key hex
 * (`01…` ed25519 / `02…` secp256k1) and derives the account hash, or a bare 64-hex account hash
 * (passed through). Returns null for anything else (e.g. a `demo-…` key).
 */
export function toAccountHashHex(account: string): string | null {
  const clean = account.trim().replace(/^0x/, '').replace(/^account-hash-/, '');
  if (/^(01[0-9a-fA-F]{64}|02[0-9a-fA-F]{66})$/.test(clean)) {
    return PublicKey.fromHex(clean).accountHash().toHex().replace(/^account-hash-/, '');
  }
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return clean.toLowerCase();
  return null;
}

/** Odra dictionary item key for a `Mapping<Address, _>` slot keyed by `accountHashHex`. */
function ledgerItemKey(fieldIndex: number, accountHashHex: string): string {
  const mapKey = new ByteWriter().accountAddress(accountHashHex).finish(); // Key::Account = 0x00 ++ hash
  return odraDictionaryItemKey(fieldIndex, mapKey);
}

async function readSlot(
  chain: ChainClient,
  contractHash: string,
  fieldIndex: number,
  accountHashHex: string,
): Promise<bigint> {
  const bytes = await chain.getDictionaryBytes(
    contractHash,
    ODRA_STATE_DICTIONARY,
    ledgerItemKey(fieldIndex, accountHashHex),
  );
  // A missing dictionary entry (account never touched this bucket) is an expected zero.
  if (!bytes || bytes.length === 0) return 0n;
  try {
    return new ByteReader(bytes).uint();
  } catch {
    return 0n;
  }
}

/**
 * Read one account's on-chain ledger slice from the deployed vault. `contractHash` is the vault's
 * **active contract hash** (resolved from the package hash by the caller). Returns null when the
 * account reference is not a real chain account; a real account with no deposits reads as all-zero.
 */
export async function readAccountLedger(
  chain: ChainClient,
  contractHash: string,
  account: string,
): Promise<VaultBalances | null> {
  const accountHashHex = toAccountHashHex(account);
  if (!accountHashHex) return null;
  const [cspr, scspr, csprusd] = await Promise.all([
    readSlot(chain, contractHash, LEDGER_FIELD_INDEX.cspr, accountHashHex),
    readSlot(chain, contractHash, LEDGER_FIELD_INDEX.scspr, accountHashHex),
    readSlot(chain, contractHash, LEDGER_FIELD_INDEX.csprusd, accountHashHex),
  ]);
  return { cspr: cspr.toString(), scspr: scspr.toString(), csprusd: csprusd.toString() };
}
