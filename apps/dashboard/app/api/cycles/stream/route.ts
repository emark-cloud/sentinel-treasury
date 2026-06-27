/**
 * Live cycle stream — a server-side passthrough of the runner's SSE feed so the browser subscribes
 * same-origin (no CORS, runner host stays private). Each upstream `data:` frame is a `CycleView`.
 * When the runner isn't configured, returns a minimal stream that tells EventSource to back off.
 */
import { runnerBaseUrl } from '../../../../lib/server/runnerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
};

export async function GET() {
  const base = runnerBaseUrl();
  if (!base) {
    // No runner: tell the EventSource to retry slowly rather than hammering a dead endpoint.
    return new Response('retry: 30000\n\n', { headers: SSE_HEADERS });
  }
  try {
    const upstream = await fetch(`${base}/cycles/stream`, {
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
    });
    if (!upstream.ok || !upstream.body) {
      return new Response('retry: 30000\n\n', { headers: SSE_HEADERS });
    }
    return new Response(upstream.body, { status: 200, headers: SSE_HEADERS });
  } catch {
    return new Response('retry: 30000\n\n', { headers: SSE_HEADERS });
  }
}
