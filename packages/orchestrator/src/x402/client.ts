/**
 * x402 client (spec §5.2) — the one visible machine-payment in the loop.
 *
 * Flow: GET the premium endpoint → on `402 Payment Required`, read `PaymentRequirements` →
 * build + EIP-712-sign an EIP-3009 `TransferWithAuthorization` → facilitator `/verify` then
 * `/settle` → retry the request with the `X-PAYMENT` proof header → receive the premium signal.
 *
 * The caller gates *whether* to pay through the `BudgetGuard` (spec §11); this client performs a
 * pull once permitted and returns the settlement facts for the receipt + the budget accounting.
 */
import { randomBytes } from 'node:crypto';
import type {
  PaymentRequirement,
  PaymentRequirementsResponse,
  PaymentPayload,
  TransferAuthorization,
  VerifyResponse,
  SettleResponse,
} from './types.js';
import { encodePaymentHeader } from './types.js';
import type { X402Signer, Eip712Domain } from './eip712.js';

/** The premium endpoint's payload (spec §5.3 `premiumSignal`). */
export interface PremiumSignalData {
  riskIndex: number;
  [k: string]: unknown;
}

export interface PremiumPullResult {
  signal: PremiumSignalData;
  settleTx: string;
  amountMotes: bigint;
  asset: string;
}

export interface X402ClientOptions {
  facilitatorUrl: string;
  /** CSPR.cloud access token — also authorizes the hosted facilitator (resources.md §6). */
  accessToken: string;
  network: string; // casper:casper-test (also the EIP-712 domain `chain_name`)
  signer: X402Signer;
  /** x402 protocol version. The cspr.cloud facilitator advertises **2** (D-012). */
  x402Version?: number;
  fetchImpl?: typeof fetch;
}

export class X402PaymentError extends Error {}

export class X402Client {
  private readonly facilitatorUrl: string;
  private readonly token: string;
  private readonly network: string;
  private readonly signer: X402Signer;
  private readonly version: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: X402ClientOptions) {
    this.facilitatorUrl = opts.facilitatorUrl.replace(/\/$/, '');
    this.token = opts.accessToken;
    this.network = opts.network;
    this.signer = opts.signer;
    this.version = opts.x402Version ?? 2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Choose a requirement we can satisfy (matching scheme + network). */
  private selectRequirement(reqs: PaymentRequirement[]): PaymentRequirement {
    const match = reqs.find((r) => r.scheme === 'exact' && r.network === this.network);
    if (!match) throw new X402PaymentError('no acceptable exact/network payment requirement');
    return match;
  }

  private buildAuthorization(req: PaymentRequirement, now: number): TransferAuthorization {
    const validAfter = Math.floor(now / 1000) - 5;
    const validBefore = Math.floor(now / 1000) + req.maxTimeoutSeconds;
    return {
      from: this.signer.fromAddress,
      to: req.payTo,
      value: req.maxAmountRequired,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: `0x${randomBytes(32).toString('hex')}`,
    };
  }

  private domainFor(req: PaymentRequirement): Eip712Domain {
    return {
      name: req.extra?.name ?? 'Wrapped CSPR',
      version: req.extra?.version ?? '1',
      chainName: this.network,
      contractPackageHash: req.asset,
    };
  }

  private async verify(payload: PaymentPayload, req: PaymentRequirement): Promise<VerifyResponse> {
    const res = await this.fetchImpl(`${this.facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { Authorization: this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: this.version,
        paymentPayload: payload,
        paymentRequirements: req,
      }),
    });
    if (!res.ok) throw new X402PaymentError(`facilitator /verify → HTTP ${res.status}`);
    return (await res.json()) as VerifyResponse;
  }

  private async settle(payload: PaymentPayload, req: PaymentRequirement): Promise<SettleResponse> {
    const res = await this.fetchImpl(`${this.facilitatorUrl}/settle`, {
      method: 'POST',
      headers: { Authorization: this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: this.version,
        paymentPayload: payload,
        paymentRequirements: req,
      }),
    });
    if (!res.ok) throw new X402PaymentError(`facilitator /settle → HTTP ${res.status}`);
    return (await res.json()) as SettleResponse;
  }

  /**
   * Pull the premium signal from `resourceUrl`, paying via x402 if challenged. Returns the
   * signal plus settlement facts. Throws `X402PaymentError` on any payment-flow failure so the
   * caller can fall back (no premium signal this cycle).
   */
  async fetchPremium(resourceUrl: string, now: number = Date.now()): Promise<PremiumPullResult> {
    const first = await this.fetchImpl(resourceUrl, { headers: { Accept: 'application/json' } });

    if (first.status !== 402) {
      if (!first.ok) throw new X402PaymentError(`premium endpoint → HTTP ${first.status}`);
      // Endpoint served without payment (e.g. free tier) — no settlement.
      const signal = (await first.json()) as PremiumSignalData;
      return { signal, settleTx: '', amountMotes: 0n, asset: '' };
    }

    const body = (await first.json()) as PaymentRequirementsResponse;
    const req = this.selectRequirement(body.accepts);
    const authorization = this.buildAuthorization(req, now);
    const signature = await this.signer.signAuthorization(this.domainFor(req), authorization);

    const payload: PaymentPayload = {
      x402Version: this.version,
      scheme: 'exact',
      network: this.network,
      payload: { signature, authorization },
    };

    const verifyRes = await this.verify(payload, req);
    if (!verifyRes.isValid) {
      const detail = verifyRes.invalidMessage ? ` (${verifyRes.invalidMessage})` : '';
      throw new X402PaymentError(
        `payment invalid: ${verifyRes.invalidReason ?? 'unknown'}${detail}`,
      );
    }
    const settleRes = await this.settle(payload, req);
    if (!settleRes.success || !settleRes.transaction) {
      throw new X402PaymentError(`settlement failed: ${settleRes.errorReason ?? 'unknown'}`);
    }

    const paid = await this.fetchImpl(resourceUrl, {
      headers: { Accept: 'application/json', 'X-PAYMENT': encodePaymentHeader(payload) },
    });
    if (!paid.ok) throw new X402PaymentError(`premium retry → HTTP ${paid.status}`);
    const signal = (await paid.json()) as PremiumSignalData;

    return {
      signal,
      settleTx: settleRes.transaction,
      amountMotes: BigInt(req.maxAmountRequired),
      asset: req.asset,
    };
  }
}
