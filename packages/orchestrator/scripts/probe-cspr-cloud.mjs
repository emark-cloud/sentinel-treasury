/**
 * Live probe: CSPR.cloud REST response shapes (Phase-3 validation item 2).
 * Dumps the real JSON keys for each endpoint csprCloud.ts depends on so the
 * defensive parsing can be tightened to reality. Run: node scripts/probe-cspr-cloud.mjs
 */
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '/home/emark/sentinel-treasury/.env' });

const BASE = (process.env.CSPR_CLOUD_BASE_URL ?? 'https://api.testnet.cspr.cloud').replace(/\/$/, '');
const TOKEN = process.env.CSPR_CLOUD_ACCESS_TOKEN;
const VAULT_PKG = process.env.VAULT_CONTRACT_HASH;
const ROUTER_PKG = process.env.CSPR_TRADE_ROUTER_HASH;
const STABLE_PKG = process.env.STABLE_TOKEN_HASH?.split('#')[0].trim();
const STYKS_PKG = process.env.STYKS_PRICE_FEED_HASH;

const OWNER_HASH = 'bab4ee7d94945bdce5b0927aa1a66bf0d3a206debe9626702403e7eb978df4b7';
const AGENT_HASH = 'daf3b6c669d7592e8edf59ce191f4d53a99ae32c60efeaccb94d0d846c0a2769';
const AGENT_KEY = process.env.AGENT_PUBLIC_KEY;

function keys(obj, depth = 2) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.length} items] e.g. ${keys(obj[0], depth - 1)}`;
  if (depth <= 0) return '{…}';
  const o = {};
  for (const [k, v] of Object.entries(obj)) {
    o[k] =
      v === null || typeof v !== 'object'
        ? `${typeof v}=${JSON.stringify(v)}`.slice(0, 60)
        : keys(v, depth - 1);
  }
  return o;
}

async function probe(label, path) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, { headers: { Authorization: TOKEN, Accept: 'application/json' } });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    console.log(`\n### ${label}`);
    console.log(`GET ${path} -> HTTP ${res.status}`);
    console.log(JSON.stringify(keys(body, 3), null, 2));
  } catch (e) {
    console.log(`\n### ${label}\nGET ${path} -> ERROR ${e.message}`);
  }
}

console.log(`BASE=${BASE} token=${TOKEN ? 'set' : 'MISSING'}`);

// 1. package -> active contract hash (resolveContractHash)
await probe('contract-packages (vault)', `/contract-packages/${VAULT_PKG}`);
await probe('contract-packages (router)', `/contract-packages/${ROUTER_PKG}`);
// alt resolution endpoint mentioned in abi-spike.md
await probe('contracts?package (router)', `/contracts?contract_package_hash=${ROUTER_PKG}`);

// 2. native balance (nativeBalanceMotes)
await probe('accounts (owner)', `/accounts/${OWNER_HASH}`);
await probe('accounts (agent)', `/accounts/${AGENT_HASH}`);

// 3. CEP-18 balance (cep18Balance) — needs active contract hash of stable; resolve first
let stableContract = STABLE_PKG;
try {
  const r = await fetch(`${BASE}/contract-packages/${STABLE_PKG}`, {
    headers: { Authorization: TOKEN, Accept: 'application/json' },
  });
  const b = await r.json();
  stableContract =
    b.latest_version_contract_hash ??
    b.data?.latest_version_contract_hash ??
    b.versions?.at?.(-1)?.contract_hash ??
    STABLE_PKG;
  console.log(`\n[resolved stable active contract] ${stableContract}`);
} catch (e) {
  console.log(`stable resolve failed: ${e.message}`);
}
await probe(
  'cep18-token-balances (stable/agent key)',
  `/contracts/${stableContract}/cep18-token-balances/${AGENT_KEY}`,
);
await probe(
  'cep18-token-balances (stable/agent acct-hash)',
  `/contracts/${stableContract}/cep18-token-balances/${AGENT_HASH}`,
);

// 4. recent deploys (recentEvents)
await probe('account deploys (agent)', `/accounts/${AGENT_HASH}/deploys?page=1&limit=3`);
await probe('account deploys (owner)', `/accounts/${OWNER_HASH}/deploys?page=1&limit=3`);
