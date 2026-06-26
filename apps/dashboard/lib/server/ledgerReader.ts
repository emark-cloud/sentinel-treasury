/**
 * Per-account ledger reader — the missing piece behind "I deposited but can't see my balance".
 *
 * The multi-tenant vault (`packages/contracts/src/vault.rs`) credits each depositor's own ledger
 * slice in three `Mapping<Address, U256>` fields (`cspr_of` / `scspr_of` / `csprusd_of`). Those are
 * the values the contract's `account_balances(account)` view returns. There is no off-chain index
 * of them, so to show a depositor their position we read the underlying Odra storage dictionary by
 * JSON-RPC and reconstruct the `VaultBalances` directly.
 *
 * Odra storage layout (verified live against the deployed D-015 vault, account `0203ddd6…`'s 100
 * CSPR deposit decoding byte-for-byte):
 *  - all module storage lives in one dictionary named `state` (the Odra `STATE_KEY`);
 *  - a struct field's dictionary item key is `hex(blake2b256( u32_be(field_index) ++ map_key ))`,
 *    where `field_index` is the **1-based** position of the field in the `#[odra::module]` struct
 *    (index 0 is reserved), and `map_key` for a `Mapping<Address, _>` is the Casper `Key`
 *    serialization of the account: tag byte `0x00` (Account) ++ the 32-byte account hash;
 *  - the stored `U256` is wrapped in a `List<U8>` blob: `[u32_le len] ++ [u8 byte_len] ++ LE bytes`.
 *
 * The reader is best-effort: any RPC/parse failure for a bucket yields `0` for that bucket, so a
 * brand-new account (no dictionary entry yet) reads as an all-zero slice rather than throwing.
 */
import { blake2b256, toHex, type VaultBalances } from '@sentinel/shared';
import { PublicKey } from 'casper-js-sdk';

/** Odra dictionary holding all contract storage. */
const ODRA_STATE_DICTIONARY = 'state';

/**
 * 1-based field indices of the per-account ledger mappings in the `SentinelVault` storage struct
 * (declaration order: owner, agent, paused, per_action_cap_usd, daily_cap_usd, max_slippage_bps,
 * min_scspr_bps, max_scspr_bps, whitelist, audit_log, action_nonce, **cspr_of, scspr_of,
 * csprusd_of**, …). Confirmed against the live deploy.
 */
const LEDGER_FIELD_INDEX = { cspr: 12, scspr: 13, csprusd: 14 } as const;

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The 32-byte account hash for `account`. Accepts a public-key hex (`01…` ed25519 / `02…`
 * secp256k1, as the Casper Wallet reports) and derives the account hash, or a bare 64-hex account
 * hash (passed straight through). Returns null for anything else (e.g. a `demo-…` key).
 */
function accountHashBytes(account: string): Uint8Array | null {
  const clean = account.trim().replace(/^0x/, '').replace(/^account-hash-/, '');
  if (/^(01[0-9a-fA-F]{64}|02[0-9a-fA-F]{66})$/.test(clean)) {
    return hexToBytes(PublicKey.fromHex(clean).accountHash().toHex().replace(/^account-hash-/, ''));
  }
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return hexToBytes(clean);
  return null;
}

/** Odra dictionary item key for a `Mapping<Address, _>` slot keyed by `accountHash`. */
function ledgerItemKey(fieldIndex: number, accountHash: Uint8Array): string {
  const mapKey = new Uint8Array([0x00, ...accountHash]); // Casper Key::Account = tag 0x00 ++ hash
  return toHex(blake2b256(new Uint8Array([...u32be(fieldIndex), ...mapKey])));
}

/** Decode a `U256` that Odra stored as a `List<U8>` blob (`[u32_le len][u8 byte_len][LE bytes]`). */
function decodeListU8U256(bytesHex: string): bigint {
  const raw = hexToBytes(bytesHex);
  if (raw.length < 5) return 0n;
  // raw[0..4] = list length (LE); raw[4] = U256 byte length; raw[5..] = little-endian value.
  const byteLen = raw[4] ?? 0;
  let value = 0n;
  for (let i = 0; i < byteLen && 5 + i < raw.length; i++) value += BigInt(raw[5 + i] ?? 0) << BigInt(8 * i);
  return value;
}

async function rpcCall(rpcUrl: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`node RPC ${method} → ${res.status}`);
  return res.json();
}

async function stateRootHash(rpcUrl: string): Promise<string> {
  const res = (await rpcCall(rpcUrl, 'chain_get_state_root_hash', {})) as {
    result?: { state_root_hash?: string };
  };
  const srh = res.result?.state_root_hash;
  if (!srh) throw new Error('node RPC: no state root hash');
  return srh;
}

interface DictResult {
  result?: { stored_value?: { CLValue?: { bytes?: string } } };
  error?: { message?: string };
}

async function readLedgerSlot(
  rpcUrl: string,
  contractHash: string,
  stateRootHash: string,
  itemKey: string,
): Promise<bigint> {
  const res = (await rpcCall(rpcUrl, 'state_get_dictionary_item', {
    state_root_hash: stateRootHash,
    dictionary_identifier: {
      ContractNamedKey: {
        key: `hash-${contractHash}`,
        dictionary_name: ODRA_STATE_DICTIONARY,
        dictionary_item_key: itemKey,
      },
    },
  })) as DictResult;
  // A missing dictionary entry (account never touched this bucket) is an expected zero, not an error.
  const bytes = res.result?.stored_value?.CLValue?.bytes;
  if (!bytes) return 0n;
  return decodeListU8U256(bytes);
}

/**
 * Read one account's on-chain ledger slice (its `account_balances`) from the deployed vault.
 * `contractHash` is the vault's **active contract hash** (resolved from the package hash by the
 * caller). Returns null when `account` is not a real chain account (e.g. a demo key).
 */
export async function readAccountLedger(
  rpcUrl: string,
  contractHash: string,
  account: string,
): Promise<VaultBalances | null> {
  const accountHash = accountHashBytes(account);
  if (!accountHash) return null;

  const srh = await stateRootHash(rpcUrl);
  const [cspr, scspr, csprusd] = await Promise.all([
    readLedgerSlot(rpcUrl, contractHash, srh, ledgerItemKey(LEDGER_FIELD_INDEX.cspr, accountHash)),
    readLedgerSlot(rpcUrl, contractHash, srh, ledgerItemKey(LEDGER_FIELD_INDEX.scspr, accountHash)),
    readLedgerSlot(rpcUrl, contractHash, srh, ledgerItemKey(LEDGER_FIELD_INDEX.csprusd, accountHash)),
  ]);
  return { cspr: cspr.toString(), scspr: scspr.toString(), csprusd: csprusd.toString() };
}

/** Named key under which Odra holds the contract's native-CSPR purse. */
const CONTRACT_MAIN_PURSE_KEY = '__contract_main_purse';

interface ContractStoredValue {
  result?: { stored_value?: { Contract?: { named_keys?: { name: string; key: string }[] } } };
  error?: { message?: string };
}

/**
 * The vault's aggregate native-CSPR balance (motes) held in its `__contract_main_purse`. Read from
 * the node, not CSPR.cloud: the vault is a legacy `Contract` (not an addressable account), so
 * CSPR.cloud's `/accounts/{hash}` reports a `null` balance for it. We resolve the purse URef from
 * the contract's named keys and query its balance. Returns 0n on any RPC/parse failure.
 */
export async function readVaultNativeMotes(rpcUrl: string, contractHash: string): Promise<bigint> {
  try {
    const srh = await stateRootHash(rpcUrl);
    const contract = (await rpcCall(rpcUrl, 'query_global_state', {
      state_identifier: { StateRootHash: srh },
      key: `hash-${contractHash}`,
      path: [],
    })) as ContractStoredValue;
    const purseUref = contract.result?.stored_value?.Contract?.named_keys?.find(
      (k) => k.name === CONTRACT_MAIN_PURSE_KEY,
    )?.key;
    if (!purseUref) return 0n;
    const bal = (await rpcCall(rpcUrl, 'query_balance', {
      state_identifier: { StateRootHash: srh },
      purse_identifier: { purse_uref: purseUref },
    })) as { result?: { balance?: string } };
    return BigInt(bal.result?.balance ?? '0');
  } catch {
    return 0n;
  }
}
