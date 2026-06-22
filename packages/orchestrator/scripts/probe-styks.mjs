/**
 * Live probe: Styks PriceFeed off-chain readability (Phase-3 validation item 1).
 * Discovers the contract's named keys / dictionaries, then attempts to read the CSPRUSD TWAP
 * off-chain and pin its U64 scale. Run: node scripts/probe-styks.mjs
 */
const NODE = 'https://node.testnet.casper.network/rpc';
const STYKS = '3f1efb55d4795bba39ab8c204b554ea16638d0ab3fe58a01e16190e7103f5a0b';

async function rpc(method, params, n = 8) {
  for (let i = 0; i < n; i++) {
    try {
      const res = await fetch(NODE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(25000),
      });
      const j = await res.json();
      return j;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`rpc ${method} failed after ${n} tries`);
}

const srh = (await rpc('chain_get_state_root_hash', [])).result.state_root_hash;
console.log('SRH', srh);

const q = await rpc('query_global_state', {
  state_identifier: { StateRootHash: srh },
  key: `hash-${STYKS}`,
  path: [],
});
if (q.error) {
  console.log('query error:', JSON.stringify(q.error));
} else {
  const sv = q.result.stored_value;
  console.log('STORED VALUE TYPE:', Object.keys(sv));
  const c = sv.Contract || sv.AddressableEntity || {};
  const nks = c.named_keys || [];
  console.log('NAMED KEYS:', nks.length);
  for (const nk of nks) console.log('   ', nk.name, '->', String(nk.key).slice(0, 50));
  const eps = (c.entry_points || []).map((e) => (typeof e === 'string' ? e : e.name));
  console.log('ENTRY POINTS:', eps);
}

export { rpc, srh, STYKS };
