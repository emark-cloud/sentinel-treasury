/**
 * Server-side JSON-RPC proxy to the Casper node.
 *
 * The public Testnet node does not send CORS headers, so a browser `fetch` straight to it is blocked
 * ("Failed to fetch"). The depositor submit path (`lib/casper/tx.ts`) points casper-js-sdk's
 * HttpHandler at this same-origin route instead; we forward the body to the real node from the
 * server (no CORS) and return the response verbatim. This mirrors how the read routes
 * (`app/api/vault`, `app/api/position`) already keep node access server-side.
 */
import { NextResponse } from 'next/server';

const NODE_RPC_URL = process.env.NODE_RPC_URL ?? 'https://node.testnet.casper.network/rpc';

export async function POST(req: Request) {
  const body = await req.text();
  try {
    const res = await fetch(NODE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32000, message: e instanceof Error ? e.message : 'node unreachable' }, id: null },
      { status: 502 },
    );
  }
}
