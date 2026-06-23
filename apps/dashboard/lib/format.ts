/** Display formatting — every machine value renders in mono; floats are always rounded. */

const CSPR_DECIMALS = 9; // native CSPR / sCSPR motes
const WUSDT_DECIMALS = 6; // Testnet stable refuge (D-005)

export function fromBaseUnits(amount: string, decimals: number): number {
  // Demo-scale values stay well inside f64 range; precision loss is not consensus-relevant
  // here (the on-chain hashes use the decimal-string base units verbatim).
  return Number(amount) / 10 ** decimals;
}

export function fmtUsd(n: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact && Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(1)}k`;
  }
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function fmtUsdMicros(micros: string): string {
  return fmtUsd(Number(micros) / 1e6);
}

export function fmtCspr(motes: string): string {
  return `${fromBaseUnits(motes, CSPR_DECIMALS).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })}`;
}

export function fmtAmount(amount: string, asset: 'CSPR' | 'sCSPR' | 'csprUSD'): string {
  const decimals = asset === 'csprUSD' ? WUSDT_DECIMALS : CSPR_DECIMALS;
  return `${fromBaseUnits(amount, decimals).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })} ${asset}`;
}

export function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

export function fmtPrice(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Truncate a 64-char hash to `0x7f…a3c1` form. */
export function truncHash(hash: string, head = 6, tail = 4): string {
  const h = hash.startsWith('0x') ? hash.slice(2) : hash;
  if (h.length <= head + tail) return `0x${h}`;
  return `0x${h.slice(0, head)}…${h.slice(-tail)}`;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
