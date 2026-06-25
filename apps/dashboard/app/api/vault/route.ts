/** Whole-vault NAV/share snapshot (server-side; keeps the CSPR.cloud token off the client). */
import { NextResponse } from 'next/server';
import { readVaultSnapshot } from '../../../lib/server/vaultReads';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const snap = await readVaultSnapshot();
    return NextResponse.json(snap);
  } catch (e) {
    return NextResponse.json(
      { live: false, error: e instanceof Error ? e.message : 'read failed' },
      { status: 200 },
    );
  }
}
