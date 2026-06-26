/**
 * Share-vault redeploy (D-014) via casper-js-sdk v5 — a workaround for odra 2.8.1's livenet
 * deployer being incompatible with the upgraded testnet node (protocol 2.2.2): odra pins
 * casper-client 5.0.0 / casper-types 6, whose transaction format the node now rejects
 * ("invalid pricing mode"). casper-js-sdk 5.0.12 speaks the current Casper 2.x format.
 *
 * Two node-side workarounds bake in here: (1) finality is confirmed via raw info_get_transaction
 * polling (`waitRaw`), because the SDK's rpc.waitForTransaction throws while deserializing finalized
 * txs on this node — and it throws AFTER finality, so it would falsely abort a good install; (2) the
 * node is a public, token-less endpoint (the SDK RpcClient sends no auth header) — not .env's authed
 * CSPR.cloud RPC. If a run dies mid-sequence anyway, re-running re-installs from the top (each install
 * uses allow_key_override) — check the owner's *_package_hash named keys before paying to redeploy.
 *
 * It installs the odra-built WASMs as ModuleBytes session transactions, reproducing exactly the
 * runtime args odra's `try_deploy_with_cfg` passes (the `odra_cfg_*` framework args + the contract
 * init args). odra reads every named arg as raw value bytes via `FromBytes`, so each arg is encoded
 * to its odra bytesrepr and wrapped in `CLValue.newCLAny(...)` (the same trick as the orchestrator's
 * `serialize.ts`). Order: AuditLog → SentinelVault → AuditLog.set_vault(vault).
 *
 * Usage (from packages/orchestrator):
 *   node scripts/deploy-sharevault.cjs --dry      # build + print the AuditLog tx, no submit
 *   node scripts/deploy-sharevault.cjs            # real deploy (spends owner CSPR)
 */
const fs = require('fs');
const path = require('path');
const sdk = require('casper-js-sdk');
const {
  RpcClient, HttpHandler, SessionBuilder, ContractCallBuilder, Args, CLValue, PublicKey, PrivateKey, KeyAlgorithm,
} = sdk;

// The casper-js-sdk RpcClient sends no auth header, so deploys must hit a public (token-less) node.
// Do NOT use .env's NODE_RPC_URL here — it points at the authed CSPR.cloud RPC (401 without a token).
// Override with DEPLOY_NODE_RPC_URL only if you have another public, no-auth node.
const NODE = process.env.DEPLOY_NODE_RPC_URL || 'https://node.testnet.casper.network/rpc';
const CHAIN = 'casper-test';
const ROOT = path.resolve(__dirname, '../../..');
const WASM_DIR = path.join(ROOT, 'packages/contracts/wasm');
const DRY = process.argv.includes('--dry');

// ---- env (contract package hashes, raw hex) ----
require('dotenv').config({ path: path.join(ROOT, '.env') });
const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v.trim();
};
const STYKS = env('STYKS_PRICE_FEED_HASH');
const ROUTER = env('CSPR_TRADE_ROUTER_HASH');
const SCSPR = env('WISE_LENDING_STAKING_HASH');
const WUSDT = env('STABLE_TOKEN_HASH');

// ---- keys ----
const ownerPubHex = fs.readFileSync(path.join(ROOT, 'keys/owner/public_key_hex'), 'utf8').trim();
const agentPubHex = fs.readFileSync(path.join(ROOT, 'keys/agent/public_key_hex'), 'utf8').trim();
const algOf = (h) => (h.startsWith('01') ? KeyAlgorithm.ED25519 : KeyAlgorithm.SECP256K1);
const ownerKey = PrivateKey.fromPem(fs.readFileSync(path.join(ROOT, 'keys/owner/secret_key.pem'), 'utf8'), algOf(ownerPubHex));
const ownerPub = PublicKey.fromHex(ownerPubHex);
const ownerAccountHash = ownerPub.accountHash().toPrefixedString().replace(/^account-hash-/, '');
const agentAccountHash = PublicKey.fromHex(agentPubHex).accountHash().toPrefixedString().replace(/^account-hash-/, '');

// ---- odra bytesrepr encoder ----
class W {
  constructor() { this.b = []; }
  u8(n) { this.b.push(n & 0xff); return this; }
  u32(n) { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, n >>> 0, true); for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i)); return this; }
  uint(v) { v = BigInt(v); const t = []; while (v > 0n) { t.push(Number(v & 0xffn)); v >>= 8n; } this.u8(t.length); for (const x of t) this.b.push(x); return this; }
  bool(x) { return this.u8(x ? 1 : 0); }
  str(s) { const u = new TextEncoder().encode(s); this.u32(u.length); for (const x of u) this.b.push(x); return this; }
  bytes32(hex) { const h = hex.replace(/^0x/, ''); for (let i = 0; i < 64; i += 2) this.b.push(parseInt(h.slice(i, i + 2), 16)); return this; }
  account(hex) { return this.u8(0).bytes32(hex); }   // Address::Account → Key tag 0
  contract(hex) { return this.u8(1).bytes32(hex); }  // Address::Contract → Key::Hash tag 1
  done() { return Uint8Array.from(this.b); }
}
const any = (w) => CLValue.newCLAny(Buffer.from(w.done()));

// odra framework args common to every upgradable install.
const cfgArgs = (name) => ({
  odra_cfg_package_hash_key_name: any(new W().str(`${name}_package_hash`)),
  odra_cfg_allow_key_override: any(new W().bool(true)),
  odra_cfg_is_upgradable: any(new W().bool(true)),
  odra_cfg_is_upgrade: any(new W().bool(false)),
});

const rpc = new RpcClient(new HttpHandler(NODE, 'fetch'));
const rawRpc = (method, params) => fetch(NODE, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}).then((r) => r.json());

/**
 * Poll info_get_transaction until the tx is executed; throw on on-chain error. Replaces the SDK's
 * rpc.waitForTransaction, which throws "Cannot read properties of undefined (reading 'length')" while
 * deserializing finalized transactions on the current testnet node (protocol 2.2.2) — that crash
 * fires AFTER the tx finalizes, so it would falsely abort a successful install mid-sequence.
 */
async function waitRaw(hashHex, label) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const j = await rawRpc('info_get_transaction', { transaction_hash: { Version1: hashHex } });
    const ei = j.result?.execution_info;
    const er = ei?.execution_result;
    if (er) {
      const v = er.Version2 || er.Version1 || er;
      if (v.error_message) throw new Error(`${label} reverted on-chain: ${v.error_message}`);
      console.log(`  ${label} finalized (block ${ei.block_height}, cost ${v.cost ?? '?'}).`);
      return;
    }
  }
  throw new Error(`${label}: not finalized after 5min (tx ${hashHex})`);
}

/** Read an account's named keys via raw state_get_entity (the SDK/CLI mis-deserialize LegacyAccount). */
async function namedKeys() {
  const j = await rawRpc('state_get_entity', { entity_identifier: { PublicKey: ownerPubHex } });
  const acct = j.result?.entity?.Account || j.result?.entity?.LegacyAccount;
  const out = {};
  for (const nk of acct?.named_keys ?? []) out[nk.name] = nk.key;
  return out;
}

async function install(name, wasmFile, initArgs, paymentMotes) {
  const wasm = new Uint8Array(fs.readFileSync(path.join(WASM_DIR, wasmFile)));
  const args = Args.fromMap({ ...initArgs, ...cfgArgs(name) });
  const tx = new SessionBuilder()
    .from(ownerPub)
    .wasm(wasm)
    .installOrUpgrade()
    .runtimeArgs(args)
    .chainName(CHAIN)
    .payment(paymentMotes)
    .build();
  tx.sign(ownerKey);
  if (DRY) {
    const j = tx.toJSON();
    console.log(`[dry] ${name}: pricing=${JSON.stringify(j?.payload?.pricing_mode || j?.transaction?.payload?.pricing_mode || 'see json')}, args=${Object.keys(initArgs).length + 4}`);
    console.log(JSON.stringify(j).slice(0, 700));
    return null;
  }
  const before = (await namedKeys())[`${name}_package_hash`];
  const res = await rpc.putTransaction(tx);
  const hash = res.transactionHash?.toHex?.() ?? res.transactionHash?.transactionV1Hash?.toHex?.() ?? JSON.stringify(res.transactionHash);
  console.log(`  ${name}: submitted ${hash} — waiting for finality…`);
  await waitRaw(hash, name);
  // Poll named keys until the package hash appears / changes (override of the prior D-013 key).
  let pkg;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    pkg = (await namedKeys())[`${name}_package_hash`];
    if (pkg && pkg !== before) break;
  }
  if (!pkg) throw new Error(`${name}: package hash not found after install`);
  if (pkg === before) console.log(`  WARN ${name}: package hash unchanged from ${before} — verify override`);
  const raw = pkg.replace(/^hash-/, '');
  console.log(`  ${name} deployed → ${raw}`);
  return raw;
}

(async () => {
  console.log('== Sentinel share-vault redeploy (casper-js-sdk) ==');
  console.log('owner =', ownerAccountHash, '\nagent =', agentAccountHash, '\nnode  =', NODE);

  // 1. AuditLog(admin = owner account, agent = agent account)
  const auditPkg = await install('AuditLog', 'AuditLog.wasm', {
    admin: any(new W().account(ownerAccountHash)),
    agent: any(new W().account(agentAccountHash)),
  }, 500_000_000_000);
  if (DRY) { console.log('[dry] stopping after AuditLog build.'); return; }

  // 2. SentinelVault(owner, agent, audit_log, cfg, styks, router, scspr, wusdt)
  const cfg = new W().uint(50_000_000n).uint(200_000_000n).u32(100).u32(1500).u32(7000); // $50/$200, 1%, 15–70%
  const vaultPkg = await install('SentinelVault', 'SentinelVault.wasm', {
    owner: any(new W().account(ownerAccountHash)),
    agent: any(new W().account(agentAccountHash)),
    audit_log: any(new W().contract(auditPkg)),
    cfg: any(cfg),
    styks: any(new W().contract(STYKS)),
    router: any(new W().contract(ROUTER)),
    scspr: any(new W().contract(SCSPR)),
    wusdt: any(new W().contract(WUSDT)),
  }, 700_000_000_000);

  // 3. AuditLog.set_vault(vault) — bind the vault as the cross-contract writer (admin-only).
  console.log('  set_vault: binding vault as AuditLog writer…');
  const sv = new ContractCallBuilder()
    .from(ownerPub)
    .byPackageHash(auditPkg)
    .entryPoint('set_vault')
    .runtimeArgs(Args.fromMap({ vault: any(new W().contract(vaultPkg)) }))
    .chainName(CHAIN)
    .payment(20_000_000_000)
    .build();
  sv.sign(ownerKey);
  const svRes = await rpc.putTransaction(sv);
  const svHash = svRes.transactionHash?.toHex?.() ?? JSON.stringify(svRes.transactionHash);
  console.log('  set_vault submitted', svHash, '— waiting…');
  await waitRaw(svHash, 'set_vault');

  console.log('\n== DEPLOY COMPLETE ==');
  console.log('VAULT_CONTRACT_HASH=' + vaultPkg);
  console.log('AUDITLOG_CONTRACT_HASH=' + auditPkg);
})().catch((e) => { console.error('DEPLOY FAILED:', e?.message || e); process.exit(1); });
