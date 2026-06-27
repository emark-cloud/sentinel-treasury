/**
 * Runner HTTP + SSE surface — the seam the dashboard reads real cycles from (its API routes proxy
 * here). Thin `node:http`, no framework, mirroring `x402/premiumServer.ts`:
 *
 *   GET /status         → RunnerStatus JSON (running / paused / last + next run / account count)
 *   GET /cycles?limit=N → { cycles: CycleView[] } newest first (rich replay on dashboard load)
 *   GET /cycles/stream  → SSE; one `data:` frame per cycle as the runner completes it (live feed)
 *
 * Decoupled from the dashboard host (Railway-friendly): the dashboard reaches it via `RUNNER_API_URL`.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { CycleView, Receipt, RunnerStatus } from '@sentinel/shared';
import type { CycleHistoryStore } from './cycleHistoryStore.js';

export interface RunnerServerDeps {
  history: CycleHistoryStore;
  getStatus: () => RunnerStatus;
  /** Read the latest `n` on-chain AuditLog receipts (the verifiable backbone); omit to disable. */
  getReceipts?: (limit: number) => Promise<Receipt[]>;
  /** SSE keep-alive comment interval (ms); default 25s (under typical proxy idle timeouts). */
  keepAliveMs?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function makeRunnerHandler(deps: RunnerServerDeps) {
  const keepAliveMs = deps.keepAliveMs ?? 25_000;

  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/status') {
      sendJson(res, 200, deps.getStatus());
      return;
    }

    if (url.pathname === '/cycles') {
      const limit = Number(url.searchParams.get('limit') ?? '50');
      void deps.history
        .recent(Number.isFinite(limit) ? limit : 50)
        .then((cycles) => sendJson(res, 200, { cycles }))
        .catch(() => sendJson(res, 200, { cycles: [] }));
      return;
    }

    if (url.pathname === '/receipts') {
      if (!deps.getReceipts) {
        sendJson(res, 200, { live: false, receipts: [] });
        return;
      }
      const limit = Number(url.searchParams.get('limit') ?? '20');
      void deps
        .getReceipts(Number.isFinite(limit) ? limit : 20)
        .then((receipts) => sendJson(res, 200, { live: true, receipts }))
        .catch((e: unknown) =>
          sendJson(res, 200, { live: false, receipts: [], error: (e as Error).message }),
        );
      return;
    }

    if (url.pathname === '/cycles/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      const onCycle = (cycle: CycleView): void => {
        res.write(`data: ${JSON.stringify(cycle)}\n\n`);
      };
      const unsubscribe = deps.history.subscribe(onCycle);
      const ka = setInterval(() => res.write(': keep-alive\n\n'), keepAliveMs);
      const cleanup = (): void => {
        clearInterval(ka);
        unsubscribe();
      };
      req.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };
}

/** Start the runner server on `port` (0 = ephemeral). Returns the server + bound port. */
export function startRunnerServer(
  deps: RunnerServerDeps,
  port = 0,
): Promise<{ server: Server; port: number }> {
  const server = createServer(makeRunnerHandler(deps));
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: boundPort });
    });
  });
}
