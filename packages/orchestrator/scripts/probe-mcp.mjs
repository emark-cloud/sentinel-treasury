/**
 * Live probe: CSPR.trade MCP tool arg/return shapes (Phase-3 validation item 3).
 * Lists tools + input schemas, then calls the three the mcpClient.ts depends on
 * (get_quote / get_pair_details / estimate_price_impact) and dumps the real result JSON.
 * Run: node scripts/probe-mcp.mjs   (set MCP_ENDPOINT to override)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from 'dotenv';
config({ path: '/home/emark/sentinel-treasury/.env' });

const ENDPOINT =
  process.env.MCP_ENDPOINT ??
  (process.env.CSPR_TRADE_MCP_ENDPOINT ?? '').split('#')[0].trim() ??
  'https://mcp.cspr.trade/mcp';

const BASE = 'sCSPR';
const QUOTE = 'WUSDT';

const client = new Client({ name: 'sentinel-probe', version: '0.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
console.log('connecting to', ENDPOINT);
await client.connect(transport);
console.log('connected.');

const tools = await client.listTools();
const want = ['get_quote', 'get_pair_details', 'estimate_price_impact', 'analyze_trade', 'estimate_slippage'];
for (const t of tools.tools) {
  if (want.includes(t.name)) {
    console.log(`\n## TOOL ${t.name}`);
    console.log('  inputSchema props:', Object.keys(t.inputSchema?.properties ?? {}).join(', '));
    console.log('  required:', JSON.stringify(t.inputSchema?.required ?? []));
  }
}

function firstText(res) {
  const t = res.content?.find((c) => c.type === 'text')?.text;
  try { return JSON.parse(t); } catch { return t; }
}

async function call(name, args) {
  console.log(`\n### CALL ${name} ${JSON.stringify(args)}`);
  try {
    const res = await client.callTool({ name, arguments: args });
    const parsed = firstText(res);
    console.log(typeof parsed === 'object' ? JSON.stringify(parsed, null, 1).slice(0, 1200) : String(parsed).slice(0, 600));
  } catch (e) {
    console.log('ERROR', e.message);
  }
}

await call('get_quote', { token_in: BASE, token_out: QUOTE, amount: '1' });
await call('get_pair_details', { token_a: BASE, token_b: QUOTE });
await call('estimate_price_impact', { token_in: BASE, token_out: QUOTE, amount_usd: 100 });

await client.close();
