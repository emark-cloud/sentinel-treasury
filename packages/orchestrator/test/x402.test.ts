import { describe, it, expect } from 'vitest';
import {
  buildPaymentRequirements,
  makePremiumHandler,
  type PremiumServerConfig,
} from '../src/x402/premiumServer.js';
import { X402Client } from '../src/x402/client.js';
import {
  Ed25519X402Signer,
  transferAuthorizationDigest,
  type Eip712Domain,
} from '../src/x402/eip712.js';
import {
  encodePaymentHeader,
  decodePaymentHeader,
  type PaymentPayload,
} from '../src/x402/types.js';

const cfg: PremiumServerConfig = {
  asset: 'aa'.repeat(32), // WCSPR package hash (32-byte hex)
  payTo: `01${'ee'.repeat(32)}`, // recipient Casper public key
  priceBaseUnits: '1000000000',
  network: 'casper:casper-test',
  resourceUrl: 'http://premium.local/premium',
  signalProvider: () => ({ riskIndex: 81 }),
};

describe('premium server payment requirements', () => {
  it('advertises an exact/casper-test requirement for the configured asset', () => {
    const body = buildPaymentRequirements(cfg);
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(1);
    const r = body.accepts[0]!;
    expect(r.scheme).toBe('exact');
    expect(r.network).toBe('casper:casper-test');
    expect(r.asset).toBe('aa'.repeat(32));
    expect(r.maxAmountRequired).toBe('1000000000');
  });
});

describe('X-PAYMENT header codec', () => {
  it('round-trips a payment payload', () => {
    const payload: PaymentPayload = {
      x402Version: 1,
      scheme: 'exact',
      network: 'casper:casper-test',
      payload: {
        signature: '0xdead',
        authorization: {
          from: 'a',
          to: 'b',
          value: '1',
          validAfter: '0',
          validBefore: '99',
          nonce: '0x00',
        },
      },
    };
    expect(decodePaymentHeader(encodePaymentHeader(payload))).toEqual(payload);
  });
});

describe('EIP-712 signing (Casper domain, casper-eip-712)', () => {
  const domain: Eip712Domain = {
    name: 'Wrapped CSPR',
    version: '1',
    chainName: 'casper:casper-test',
    contractPackageHash: 'aa'.repeat(32),
  };
  const auth = {
    from: `01${'bb'.repeat(32)}`, // 33-byte Casper public key
    to: `01${'cc'.repeat(32)}`,
    value: '1000000000',
    validAfter: '0',
    validBefore: '9999999999',
    nonce: `0x${'11'.repeat(32)}`,
  };

  it('produces a deterministic 32-byte digest', () => {
    const d1 = transferAuthorizationDigest(domain, auth);
    const d2 = transferAuthorizationDigest(domain, auth);
    expect(d1).toEqual(d2);
    expect(d1.length).toBe(32);
  });

  it('byte-matches the published casper-eip-712 transfer vector', () => {
    // tests/vectors.json :: casper_transfer_with_authorization (D-012 byte-match proof).
    const vecDomain: Eip712Domain = {
      name: 'CasperToken',
      version: '1',
      chainName: 'casper:casper-test',
      contractPackageHash: '77'.repeat(32),
    };
    const vecAuth = {
      from: '0x1234567890123456789012345678901234567890',
      to: '0xabcdef1234567890abcdef1234567890abcdef12',
      value: '42',
      validAfter: '0',
      validBefore: '4294967295',
      nonce: `0x${'ab'.repeat(32)}`,
    };
    const digest = Buffer.from(transferAuthorizationDigest(vecDomain, vecAuth)).toString('hex');
    expect(digest).toBe('8868576c5993b484967680e92f7d59bda3cdeb3e32443258479662866c604288');
  });

  it('signs to a Casper ed25519-tagged signature (01 ‖ 64 bytes)', async () => {
    // Deterministic test seed (do NOT use in production).
    const signer = new Ed25519X402Signer('11'.repeat(32), auth.from);
    const sig = await signer.signAuthorization(domain, auth);
    expect(sig.startsWith('01')).toBe(true);
    expect(sig.length).toBe(130); // 1-byte tag + 64-byte signature, hex
  });
});

describe('X402Client end-to-end (in-process premium server + fake facilitator)', () => {
  it('runs 402 → sign → verify → settle → retry and returns the signal', async () => {
    const handler = makePremiumHandler(cfg);
    const settleTx = 'settle-tx-hash';
    const calls: string[] = [];

    // Fake fetch: routes premium-resource requests through the real handler and facilitator
    // requests through canned responses.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url === cfg.resourceUrl) {
        const xPayment = (init?.headers as Record<string, string> | undefined)?.['X-PAYMENT'];
        return runHandler(handler, xPayment);
      }
      if (url.endsWith('/verify')) {
        return jsonResponse({ isValid: true, payer: 'me' });
      }
      if (url.endsWith('/settle')) {
        return jsonResponse({ success: true, transaction: settleTx, network: cfg.network });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const client = new X402Client({
      facilitatorUrl: 'http://facilitator.local',
      accessToken: 'token',
      network: cfg.network,
      signer: new Ed25519X402Signer('22'.repeat(32), `01${'dd'.repeat(32)}`),
      fetchImpl,
    });

    const result = await client.fetchPremium(cfg.resourceUrl);
    expect(result.signal.riskIndex).toBe(81);
    expect(result.settleTx).toBe(settleTx);
    expect(result.amountMotes).toBe(1_000_000_000n);
    // Resource fetched twice (challenge + paid retry), verify + settle each once.
    expect(calls.filter((c) => c === cfg.resourceUrl)).toHaveLength(2);
    expect(calls.some((c) => c.endsWith('/verify'))).toBe(true);
    expect(calls.some((c) => c.endsWith('/settle'))).toBe(true);
  });
});

// --- helpers: adapt the node:http handler to fetch Responses without binding a port ---

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function runHandler(
  handler: ReturnType<typeof makePremiumHandler>,
  xPayment: string | undefined,
): Promise<Response> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (xPayment) headers['x-payment'] = xPayment;
    const req = { headers } as unknown as Parameters<typeof handler>[0];
    let statusCode = 200;
    let resHeaders: Record<string, string> = {};
    let payload = '';
    const res = {
      writeHead(code: number, h: Record<string, string>) {
        statusCode = code;
        resHeaders = h;
        return this;
      },
      end(chunk?: string) {
        payload = chunk ?? '';
        resolve(new Response(payload, { status: statusCode, headers: resHeaders }));
      },
    } as unknown as Parameters<typeof handler>[1];
    handler(req, res);
  });
}
