/** On-chain AuditLog receipts (the verifiable backbone), read by the runner and proxied here. */
import { type NextRequest, NextResponse } from 'next/server';
import type { Receipt } from '@sentinel/shared';
import { runnerGet } from '../../../lib/server/runnerProxy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const limit = req.nextUrl.searchParams.get('limit') ?? '20';
  const result = await runnerGet<{ live: boolean; receipts: Receipt[] }>(
    `/receipts?limit=${limit}`,
    { live: false, receipts: [] },
  );
  return NextResponse.json(result);
}
