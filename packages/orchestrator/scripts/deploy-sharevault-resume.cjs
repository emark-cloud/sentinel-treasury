/**
 * RESUME deploy (D-014) — AuditLog already deployed successfully in the prior run
 * (tx a597c982…, package a1a2080d…). That run crashed inside the SDK's
 * rpc.waitForTransaction ("Cannot read properties of undefined (reading 'length')")
 * AFTER AuditLog finalized but BEFORE the vault was submitted. This script picks up
 * from the SentinelVault install, reusing the deployed AuditLog package, and replaces
 * waitForTransaction with raw info_get_transaction polling to dodge the SDK bug.
 *
 * Usage (from packages/orchestrator):  node scripts/deploy-sharevault-resume.cjs
 */
const fs = require('fs');
const path = require('path');
const sdk = require('casper-js-sdk');
const { RpcClient, HttpHandler, SessionBuilder, ContractCallBuilder, Args, CLValue, PublicKey, PrivateKey, KeyAlgorithm } = sdk;

const NODE = 'https://node.testnet.casper.network/rpc';
const CHAIN = 'casper-test';
const ROOT = path.resolve(__dirname, '../../..');
const WASM_DIR = path.join(ROOT, 'packages/contracts/wasm');
require('dotenv').config({ path: path.join(ROOT, '.env') });

// AuditLog already on-chain from the prior run — reuse it, do NOT reinstall.
const AUDIT_PKG = 'a1a2080d4079b81fd87a51218335d45426e7cd6f6491ccbdfe7a40911a15efdc';

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v.trim(); };
const STYKS = env('STYKS_PRICE_FEED_HASH');
const ROUTER = env('CSPR_TRADE_ROUTER_HASH');
const SCSPR = env('WISE_LENDING_STAKING_HASH');
const WUSDT = env('STABLE_TOKEN_HASH');

const ownerPubHex = fs.readFileSync(path.join(ROOT, 'keys/owner/public_key_hex'), 'utf8').trim();
const agentPubHex = fs.readFileSync(path.join(ROOT, 'keys/agent/public_key_hex'), 'utf8').trim();
const algOf = (h) => (h.startsWith('01') ? KeyAlgorithm.ED25519 : KeyAlgorithm.SECP256K1);
const ownerKey = PrivateKey.fromPem(fs.readFileSync(path.join(ROOT, 'keys/owner/secret_key.pem'), 'utf8'), algOf(ownerPubHex));
const ownerPub = PublicKey.fromHex(ownerPubHex);
const ownerAccountHash = ownerPub.accountHash().toPrefixedString().replace(/^account-hash-/, '');
const agentAccountHash = PublicKey.fromHex(agentPubHex).accountHash().toPrefixedString().replace(/^account-hash-/, '');

class W {
  constructor() { this.b = []; }
  u8(n) { this.b.push(n & 0xff); return this; }
  u32(n) { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, n >>> 0, true); for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i)); return this; }
  uint(v) { v = BigInt(v); const t = []; while (v > 0n) { t.push(Number(v & 0xffn)); v >>= 8n; } this.u8(t.length); for (const x of t) this.b.push(x); return this; }
  bool(x) { return this.u8(x ? 1 : 0); }
  str(s) { const u = new TextEncoder().encode(s); this.u32(u.length); for (const x of u) this.b.push(x); return this; }
  bytes32(hex) { const h = hex.replace(/^0x/, ''); for (let i = 0; i < 64; i += 2) this.b.push(parseInt(h.slice(i, i + 2), 16)); return this; }
  account(hex) { return this.u8(0).bytes32(hex); }
  contract(hex) { return this.u8(1).bytes32(hex); }
  done() { return Uint8Array.from(this.b); }
}
const any = (w) => CLValue.newCLAny(Buffer.from(w.done()));
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

async function namedKeys() {
  const j = await rawRpc('state_get_entity', { entity_identifier: { PublicKey: ownerPubHex } });
  const acct = j.result?.entity?.Account || j.result?.entity?.LegacyAccount;
  const out = {};
  for (const nk of acct?.named_keys ?? []) out[nk.name] = nk.key;
  return out;
}

/** Poll info_get_transaction until executed; throw on on-chain error. Dodges the SDK waitForTransaction bug. */
async function waitRaw(hashHex, label) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const j = await rawRpc('info_get_transaction', { transaction_hash: { Version1: hashHex } });
    const ei = j.result?.execution_info;
    const er = ei?.execution_result;
    if (er) {
      const v = er.Version2 || er.Version1 || er;
      const err = v.error_message;
      if (err) throw new Error(`${label} reverted on-chain: ${err}`);
      console.log(`  ${label} finalized (block ${ei.block_height}, cost ${v.cost ?? '?'}).`);
      return;
    }
  }
  throw new Error(`${label}: not finalized after 5min (tx ${hashHex})`);
}

async function install(name, wasmFile, initArgs, paymentMotes) {
  const wasm = new Uint8Array(fs.readFileSync(path.join(WASM_DIR, wasmFile)));
  const before = (await namedKeys())[`${name}_package_hash`];
  const tx = new SessionBuilder()
    .from(ownerPub).wasm(wasm).installOrUpgrade()
    .runtimeArgs(Args.fromMap({ ...initArgs, ...cfgArgs(name) }))
    .chainName(CHAIN).payment(paymentMotes).build();
  tx.sign(ownerKey);
  const res = await rpc.putTransaction(tx);
  const hash = res.transactionHash?.toHex?.() ?? JSON.stringify(res.transactionHash);
  console.log(`  ${name}: submitted ${hash} — waiting for finality…`);
  await waitRaw(hash, name);
  let pkg;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    pkg = (await namedKeys())[`${name}_package_hash`];
    if (pkg && pkg !== before) break;
  }
  if (!pkg) throw new Error(`${name}: package hash not found after install`);
  if (pkg === before) console.log(`  WARN ${name}: package hash unchanged from ${before}`);
  const raw = pkg.replace(/^hash-/, '');
  console.log(`  ${name} deployed → ${raw}`);
  return raw;
}

(async () => {
  console.log('== Sentinel share-vault RESUME (vault + set_vault) ==');
  console.log('owner =', ownerAccountHash, '\nagent =', agentAccountHash);
  console.log('reusing AuditLog package =', AUDIT_PKG, '\n');

  // 2. SentinelVault(owner, agent, audit_log, cfg, styks, router, scspr, wusdt)
  const cfg = new W().uint(50_000_000n).uint(200_000_000n).u32(100).u32(1500).u32(7000); // $50/$200, 1%, 15–70%
  const vaultPkg = await install('SentinelVault', 'SentinelVault.wasm', {
    owner: any(new W().account(ownerAccountHash)),
    agent: any(new W().account(agentAccountHash)),
    audit_log: any(new W().contract(AUDIT_PKG)),
    cfg: any(cfg),
    styks: any(new W().contract(STYKS)),
    router: any(new W().contract(ROUTER)),
    scspr: any(new W().contract(SCSPR)),
    wusdt: any(new W().contract(WUSDT)),
  }, 400_000_000_000);

  // 3. AuditLog.set_vault(vault)
  console.log('  set_vault: binding vault as AuditLog writer…');
  const sv = new ContractCallBuilder()
    .from(ownerPub).byPackageHash(AUDIT_PKG).entryPoint('set_vault')
    .runtimeArgs(Args.fromMap({ vault: any(new W().contract(vaultPkg)) }))
    .chainName(CHAIN).payment(20_000_000_000).build();
  sv.sign(ownerKey);
  const svRes = await rpc.putTransaction(sv);
  const svHash = svRes.transactionHash?.toHex?.() ?? JSON.stringify(svRes.transactionHash);
  console.log('  set_vault submitted', svHash, '— waiting…');
  await waitRaw(svHash, 'set_vault');

  console.log('\n== DEPLOY COMPLETE ==');
  console.log('VAULT_CONTRACT_HASH=' + vaultPkg);
  console.log('AUDITLOG_CONTRACT_HASH=' + AUDIT_PKG);
})().catch((e) => { console.error('RESUME FAILED:', e?.message || e); process.exit(1); });
