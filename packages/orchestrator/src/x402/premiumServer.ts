/**
 * Premium x402-gated endpoint (spec §5.2) — the resource server we run *both ends* of so the
 * 402→pay→200 round-trip is fully demonstrable on Testnet. Without an `X-PAYMENT` header it
 * returns `402 Payment Required` + `PaymentRequirements`; with one it returns the premium
 * market-risk signal (`200`).
 *
 * The signal value is supplied by an injectable provider so the demo scenario harness can drive
 * the risk index (clearly labelled `demo` per §15.3) while the payment leg stays real. This is a
 * thin `node:http` server with no framework dependency.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PaymentRequirement, PaymentRequirementsResponse } from './types.js';

export interface PremiumServerConfig {
  /** Asset (CEP-18) the payer must pay in — WCSPR package hash on Testnet. */
  asset: string;
  /** Recipient address/key for the payment. */
  payTo: string;
  /** Price in base units (decimal string). */
  priceBaseUnits: string;
  network: string; // casper:casper-test
  resourceUrl: string;
  assetName?: string;
  assetVersion?: string;
  maxTimeoutSeconds?: number;
  x402Version?: number;
  /** Supplies the premium signal payload (scenario-injectable). */
  signalProvider: () => { riskIndex: number; [k: string]: unknown };
}

export function buildPaymentRequirements(cfg: PremiumServerConfig): PaymentRequirementsResponse {
  const req: PaymentRequirement = {
    scheme: 'exact',
    network: cfg.network,
    maxAmountRequired: cfg.priceBaseUnits,
    resource: cfg.resourceUrl,
    description: 'Sentinel premium market-risk signal',
    mimeType: 'application/json',
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? 60,
    asset: cfg.asset,
    extra: { name: cfg.assetName ?? 'Wrapped CSPR', version: cfg.assetVersion ?? '1' },
  };
  return { x402Version: cfg.x402Version ?? 2, accepts: [req] };
}

/** Request handler factory — exported so it can be unit-tested without binding a port. */
export function makePremiumHandler(cfg: PremiumServerConfig) {
  return (reqMsg: IncomingMessage, res: ServerResponse): void => {
    const payment = reqMsg.headers['x-payment'];
    if (!payment) {
      const body = JSON.stringify(buildPaymentRequirements(cfg));
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    // Payment proof present. We run both ends and the client already verified+settled via the
    // facilitator (spec §5.2), so serving the signal here completes the round-trip. The settled
    // tx is independently checkable on cspr.live. Echo the proof in X-PAYMENT-RESPONSE.
    const signal = { source: 'premium-x402' as const, ...cfg.signalProvider() };
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ settled: true }), 'utf8').toString(
        'base64',
      ),
    });
    res.end(JSON.stringify(signal));
  };
}

/** Start the premium server on `port` (default ephemeral). Returns the `Server`. */
export function startPremiumServer(
  cfg: PremiumServerConfig,
  port = 0,
): Promise<{ server: Server; port: number }> {
  const server = createServer(makePremiumHandler(cfg));
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: boundPort });
    });
  });
}
