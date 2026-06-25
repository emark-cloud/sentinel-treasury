/** A connected account's vault position (server-side read). */
import { type NextRequest, NextResponse } from 'next/server';
import { readPositionFor } from '../../../lib/server/vaultReads';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const account = req.nextUrl.searchParams.get('account');
  if (!account) return NextResponse.json({ live: false, position: null }, { status: 400 });
  try {
    const result = await readPositionFor(account);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { live: false, position: null, error: e instanceof Error ? e.message : 'read failed' },
      { status: 200 },
    );
  }
}
