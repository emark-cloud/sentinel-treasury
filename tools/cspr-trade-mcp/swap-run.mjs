// One-shot swap driver: build_swap -> sign_deploy -> submit_transaction over the
// self-hosted CSPR.trade MCP (main + --signer instances), in-memory (no argv size limits).
// Usage: node swap-run.mjs <token_in> <token_out> <amount> <slippage_bps> <deadline_min>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';

const RPC = 'https://node.testnet.casper.network/rpc';
function waitForTx(hash, label) {
  console.error(`--- waiting for ${label} (${hash}) to finalize ---`);
  for (let i = 0; i < 25; i++) {
    const r = spawnSync('casper-client', ['get-transaction', '--node-address', RPC, hash], { encoding: 'utf8' });
    try {
      const er = JSON.parse(r.stdout).result?.execution_info?.execution_result;
      if (er) {
        const v2 = er.Version2 ?? er;
        if (v2.error_message) throw new Error(`${label} reverted: ${v2.error_message}`);
        console.error(`${label} finalized OK (gas ${(Number(v2.consumed) / 1e9).toFixed(2)} CSPR)`);
        return;
      }
    } catch (e) { if (String(e.message).includes('reverted')) throw e; }
    spawnSync('sleep', ['10']);
  }
  throw new Error(`${label} not finalized after ~250s`);
}
function parseHash(submitText) {
  const m = submitText.match(/Hash:\s*([0-9a-fA-F]{64})/);
  return m ? m[1] : null;
}

const [tokenIn, tokenOut, amount, slippageBps = '150', deadlineMin = '30'] = process.argv.slice(2);
const AGENT = '01a4e9a55d4546c2e3d11643b6cdf3192a4c6db36b987704afd6e0d88009309fd6';
const ENTRY = './node_modules/@make-software/cspr-trade-mcp/dist/index.js';
const KEY = '../../keys/agent/secret_key.pem';

function mkClient(extraArgs, extraEnv) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [ENTRY, ...extraArgs],
    env: { ...process.env, CSPR_TRADE_NETWORK: 'testnet', ...extraEnv },
  });
  const client = new Client({ name: 'sentinel-driver', version: '0' }, { capabilities: {} });
  return { client, transport };
}

async function call(client, name, args, timeoutMs = 60000) {
  const res = await client.callTool({ name, arguments: args }, undefined, {
    timeout: timeoutMs, resetTimeoutOnProgress: true,
  });
  return res.content.map((c) => c.text ?? '').join('\n');
}

// Pull a balanced JSON object out of the human-readable build text after `marker`.
function extractJson(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const sub = text.slice(i + marker.length);
  const s = sub.indexOf('{');
  if (s < 0) return null;
  let depth = 0;
  for (let j = s; j < sub.length; j++) {
    if (sub[j] === '{') depth++;
    else if (sub[j] === '}') { depth--; if (depth === 0) return sub.slice(s, j + 1); }
  }
  return null;
}

const main = mkClient([], {});
const signer = mkClient(['--signer'], { CSPR_TRADE_KEY_PATH: KEY });

await main.client.connect(main.transport);
await signer.client.connect(signer.transport);

try {
  console.error(`\n=== build_swap ${amount} ${tokenIn} -> ${tokenOut} (slip ${slippageBps}bps, ${deadlineMin}min) ===`);
  const built = await call(main.client, 'build_swap', {
    token_in: tokenIn, token_out: tokenOut, amount, type: 'exact_in',
    slippage_bps: Number(slippageBps), deadline_minutes: Number(deadlineMin),
    sender_public_key: AGENT,
  });
  // Print the human summary (first lines before the JSON dumps)
  console.error(built.split('Approval transaction JSON:')[0].split('Swap transaction JSON:')[0].trim());

  const approveJson = extractJson(built, 'Approval transaction JSON:');
  const swapJson = extractJson(built, 'Swap transaction JSON:');
  if (!swapJson) throw new Error('could not parse swap transaction JSON from build output');

  async function signAndSubmit(label, unsignedJson) {
    console.error(`\n--- sign ${label} ---`);
    const signed = await call(signer.client, 'sign_deploy', {
      deploy_json: unsignedJson, key_source: 'pem_file', algorithm: 'ed25519',
    });
    // sign_deploy returns the signed JSON (possibly wrapped in text); extract the object.
    const signedJson = extractJson(signed, '') ?? signed.trim();
    console.error(`--- submit ${label} ---`);
    const sub = await call(main.client, 'submit_transaction', { signed_deploy_json: signedJson }, 240000);
    console.error(sub.trim());
    return parseHash(sub);
  }

  if (approveJson) {
    const approveHash = await signAndSubmit('APPROVE', approveJson);
    if (approveHash) waitForTx(approveHash, 'APPROVE');
  }
  const swapHash = await signAndSubmit('SWAP', swapJson);
  if (swapHash) waitForTx(swapHash, 'SWAP');
  console.error('\n=== DONE ===');
} finally {
  await main.client.close().catch(() => {});
  await signer.client.close().catch(() => {});
}
