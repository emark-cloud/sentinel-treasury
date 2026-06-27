/** Recent real cycles from the autonomous runner (server-side proxy). */
import { type NextRequest, NextResponse } from 'next/server';
import type { CycleView } from '@sentinel/shared';
import { runnerBaseUrl, runnerGet } from '../../../lib/server/runnerProxy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const limit = req.nextUrl.searchParams.get('limit') ?? '50';
  const live = runnerBaseUrl() !== null;
  const { cycles } = await runnerGet<{ cycles: CycleView[] }>(`/cycles?limit=${limit}`, {
    cycles: [],
  });
  return NextResponse.json({ live, cycles });
}
