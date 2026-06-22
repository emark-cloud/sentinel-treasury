/**
 * Live probe: EIP-712 byte-match vs the x402 facilitator (Phase-3 validation item 4).
 * (1) Confirms the official @casper-ecosystem/casper-eip-712 digest matches the repo vector.
 * (2) Builds a v2 payment payload, signs the digest with the agent ed25519 key, and POSTs
 *     /verify to see how far the facilitator accepts our encoding.
 */
import { readFileSync } from 'node:fs';
import { hashTypedData, toHex } from '@casper-ecosystem/casper-eip-712';
import { ed25519 } from '@noble/curves/ed25519';
import { config } from 'dotenv';
config({ path: '/home/emark/sentinel-treasury/.env' });

const DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chain_name', type: 'string' },
  { name: 'contract_package_hash', type: 'bytes32' },
];
const TWA_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

// (1) byte-match the published vector
const vec = {
  domain: { name: 'CasperToken', version: '1', chain_name: 'casper:casper-test', contract_package_hash: '0x7777777777777777777777777777777777777777777777777777777777777777' },
  message: { from: '0x1234567890123456789012345678901234567890', to: '0xabcdef1234567890abcdef1234567890abcdef12', value: '0x000000000000000000000000000000000000000000000000000000000000002a', validAfter: '0x0000000000000000000000000000000000000000000000000000000000000000', validBefore: '0x00000000000000000000000000000000000000000000000000000000ffffffff', nonce: '0xabababababababababababababababababababababababababababababababab' },
  expected: '0x8868576c5993b484967680e92f7d59bda3cdeb3e32443258479662866c604288',
};
const d = toHex(hashTypedData(vec.domain, TWA_TYPES, 'TransferWithAuthorization', vec.message, { domainTypes: DOMAIN_TYPES }));
console.log('vector digest match:', d === vec.expected, d);

// (2) live verify attempt
const FAC = (process.env.X402_FACILITATOR_URL ?? 'https://x402-facilitator.cspr.cloud').replace(/\/$/, '');
const TOKEN = process.env.CSPR_CLOUD_ACCESS_TOKEN;
const WCSPR = (process.env.WCSPR_HASH ?? '').split('#')[0].trim();
const AGENT_PUB = (process.env.AGENT_PUBLIC_KEY ?? '').trim(); // 01 + 32 bytes (ed25519)

// load agent ed25519 secret from PEM (PKCS8: last 32 bytes of the DER seed)
const pem = readFileSync('/home/emark/sentinel-treasury/keys/agent/secret_key.pem', 'utf8');
const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const seed = der.subarray(der.length - 32); // ed25519 PKCS8 ends with the 32-byte seed
const pub = Buffer.from(ed25519.getPublicKey(seed));
console.log('derived pub matches AGENT_PUBLIC_KEY:', '01' + pub.toString('hex') === AGENT_PUB);

const from = '0x' + AGENT_PUB; // 33-byte casper public key (lib encodes via keccak)
const payToPub = (process.env.OWNER_PUBLIC_KEY ?? '').trim();
const to = '0x' + payToPub;
const value = '0x' + (1000000n).toString(16).padStart(64, '0');
const now = Math.floor(Date.now() / 1000);
const u256 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const message = { from, to, value, validAfter: u256(now - 5), validBefore: u256(now + 300), nonce: '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex') };
const domain = { name: 'Wrapped CSPR', version: '1', chain_name: 'casper:casper-test', contract_package_hash: '0x' + WCSPR };
const digest = hashTypedData(domain, TWA_TYPES, 'TransferWithAuthorization', message, { domainTypes: DOMAIN_TYPES });
const sig = ed25519.sign(digest, seed);
const signature = '01' + Buffer.from(sig).toString('hex'); // 01 = ed25519 algo tag (casper convention)

const requirements = {
  scheme: 'exact', network: 'casper:casper-test', maxAmountRequired: '1000000',
  resource: 'https://example/premium', description: 'premium signal', mimeType: 'application/json',
  payTo: payToPub, maxTimeoutSeconds: 300, asset: WCSPR,
  extra: { name: 'Wrapped CSPR', version: '1' },
};
const payload = { x402Version: 2, scheme: 'exact', network: 'casper:casper-test', payload: { signature, authorization: message } };

async function verify(body, tag) {
  const res = await fetch(`${FAC}/verify`, { method: 'POST', headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  console.log(`\n[verify ${tag}] HTTP ${res.status}:`, JSON.stringify(j));
}
await verify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }, 'evm-twa/ed25519');

// iterate on v2 payload encoding for the empty-scheme issue
const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
await verify({ x402Version: 2, paymentPayload: b64, paymentRequirements: requirements }, 'b64-payload');
await verify({ x402Version: 2, paymentPayload: payload, paymentRequirements: { ...requirements } , scheme:'exact'}, 'scheme-top');
// maybe requirements must be list under accepts
await verify({ x402Version: 2, paymentPayload: payload, paymentRequirements: { accepts:[requirements] } }, 'accepts-list');
// maybe payload.payload must be base64 string of {signature,authorization}
const inner = Buffer.from(JSON.stringify({ signature, authorization: message })).toString('base64');
await verify({ x402Version: 2, paymentPayload: { x402Version:2, scheme:'exact', network:'casper:casper-test', payload: inner }, paymentRequirements: requirements }, 'inner-b64');
