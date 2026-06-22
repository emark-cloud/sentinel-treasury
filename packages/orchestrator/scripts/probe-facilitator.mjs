/**
 * Live probe: x402 facilitator API contract (Phase-3 validation item 4, discovery pass).
 * Learns the facilitator's expected request/response by hitting its discovery + verify routes,
 * before we attempt a real signed /verify. Run: node scripts/probe-facilitator.mjs
 */
import { config } from 'dotenv';
config({ path: '/home/emark/sentinel-treasury/.env' });

const FAC = (process.env.X402_FACILITATOR_URL ?? 'https://x402-facilitator.cspr.cloud').replace(/\/$/, '');
const TOKEN = process.env.CSPR_CLOUD_ACCESS_TOKEN;

async function hit(method, path, body) {
  const url = `${FAC}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 400); }
    console.log(`\n### ${method} ${path} -> HTTP ${res.status}`);
    console.log(typeof parsed === 'object' ? JSON.stringify(parsed, null, 1).slice(0, 1200) : parsed);
  } catch (e) {
    console.log(`\n### ${method} ${path} -> ERROR ${e.message}`);
  }
}

console.log(`FAC=${FAC}`);
await hit('GET', '/');
await hit('GET', '/supported');
await hit('GET', '/verify');
await hit('GET', '/discovery/resources');
// malformed verify to read the error contract (what fields it expects)
await hit('POST', '/verify', { x402Version: 1 });
await hit('POST', '/settle', { x402Version: 1 });
