/** Autonomous runner liveness + scheduling status (drives the dashboard loop header). */
import { NextResponse } from 'next/server';
import type { RunnerStatus } from '@sentinel/shared';
import { runnerBaseUrl, runnerGet } from '../../../lib/server/runnerProxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  const live = runnerBaseUrl() !== null;
  const status = await runnerGet<RunnerStatus | null>('/status', null);
  return NextResponse.json({ live, status });
}
