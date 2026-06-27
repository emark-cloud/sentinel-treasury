/**
 * Server-side proxy to the autonomous runner (`packages/orchestrator/src/runner`).
 *
 * The runner exposes the agent's real activity — recent cycles, the live SSE feed, on-chain
 * receipts, and liveness status — on `RUNNER_API_URL`. The dashboard reaches it only from the
 * server (these route handlers), the same way `vaultReads` keeps the CSPR.cloud token off the
 * browser. When `RUNNER_API_URL` is unset (default in a fresh checkout) the dashboard falls back to
 * the in-memory demo source — the same honesty seam the rest of the UI uses.
 */
const RUNNER_API_URL = process.env.RUNNER_API_URL?.replace(/\/$/, '');

/** The runner base URL, or null when not configured (caller falls back to demo). */
export function runnerBaseUrl(): string | null {
  return RUNNER_API_URL ?? null;
}

/** GET a runner JSON path; returns `fallback` on missing config or any failure (never throws). */
export async function runnerGet<T>(path: string, fallback: T): Promise<T> {
  if (!RUNNER_API_URL) return fallback;
  try {
    const res = await fetch(`${RUNNER_API_URL}${path}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}
