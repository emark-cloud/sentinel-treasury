/**
 * CSPR.trade MCP client (spec §5.1, §7.3; docs/cspr-trade-mcp.md).
 *
 * Supplies the market-data fields the Scout can't get from Styks: spot price, pool depth, and
 * the price-impact curve used for slippage sizing (`pre_trade_analysis` discipline — D-003).
 *
 * **Tool shapes — confirmed live (2026-06-22, D-012):**
 *  - `get_quote` requires `{ token_in, token_out, amount, type }` with `type ∈ {exact_in,exact_out}`
 *    and `amount` a **token-unit string**; it returns JSON
 *    `{ amountIn, amountOut, amountInFormatted, amountOutFormatted, executionPrice, midPrice,
 *       path, pathSymbols, priceImpact, recommendedSlippageBps, tokenInDecimals, tokenOutDecimals }`.
 *  - `get_pair_details` takes `{ pair }` where `pair` is the **pair contract package hash**, and
 *    returns `{ token0{packageHash,symbol,decimals}, token1{…}, reserve0, reserve1, fiatPrice0,
 *    fiatPrice1 }` (fiat prices are `null` on Testnet).
 *  - `estimate_price_impact` / `estimate_slippage` / `analyze_trade` return **prose text**, not
 *    JSON, so the price-impact curve is derived from `get_quote.priceImpact` instead.
 *  - Tokens are identified by symbol **or** contract/package hash. Use the hashes from config: the
 *    public `mcp.cspr.trade` endpoint resolves a *different* token registry than our Testnet
 *    config, so the orchestrator must point `CSPR_TRADE_MCP_ENDPOINT` at the **self-hosted**
 *    server (`CSPR_TRADE_NETWORK=testnet`), which recognises our WCSPR/sCSPR/WUSDT hashes (D-012).
 *  - Testnet DEX quotes are token-to-token (no USD oracle); `spotUsd`/`depthUsd` are therefore
 *    only ~USD when the `quote` token is the stable refuge (WUSDT, ~$1). Everything is behind
 *    `MarketDataProvider` so the Scout runs against a static provider in tests.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PriceImpactSample } from '@sentinel/shared';

export interface MarketData {
  /** Spot price of `base` in `quote` units (≈ USD when `quote` is the stable refuge). */
  spotUsd: number;
  /** Stable-side pool depth (≈ USD when `quote` is the stable refuge). */
  depthUsd: number;
}

/** Market data + slippage sizing, abstracted from the MCP transport. */
export interface MarketDataProvider {
  getMarketData(): Promise<MarketData>;
  /** Projected price impact (bps) for each trade size (USD), via MCP quotes. */
  priceImpactCurve(sizesUsd: number[]): Promise<PriceImpactSample[]>;
}

interface ToolTextResult {
  content?: { type: string; text?: string }[];
}

function toolText(result: unknown): string {
  const r = result as ToolTextResult;
  const text = r.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error('MCP tool returned no text content');
  return text;
}

function parseToolJson<T>(result: unknown): T {
  return JSON.parse(toolText(result)) as T;
}

interface QuoteResult {
  amountOut?: string;
  amountOutFormatted?: string;
  executionPrice?: string;
  midPrice?: string;
  priceImpact?: string; // percent, e.g. "0.3039"
  recommendedSlippageBps?: string;
}

interface PairDetails {
  token0?: { packageHash?: string; symbol?: string; decimals?: number };
  token1?: { packageHash?: string; symbol?: string; decimals?: number };
  reserve0?: string;
  reserve1?: string;
}

export interface CsprTradeMcpOptions {
  endpoint: string;
  /** Tokens the de-risk pair trades between (sCSPR → stable), by symbol or contract/package hash. */
  pair: { base: string; quote: string };
  /** Pair contract package hash, for the depth read via `get_pair_details`. */
  pairPackageHash?: string;
}

/** MCP-backed market data provider. Lazily connects on first call; remember to `close()`. */
export class CsprTradeMcpProvider implements MarketDataProvider {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;

  constructor(private readonly opts: CsprTradeMcpOptions) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'sentinel-orchestrator', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.endpoint));
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    this.client = client;
    this.transport = transport;
    return client;
  }

  private async quote(amount: string): Promise<QuoteResult> {
    const client = await this.ensureConnected();
    return parseToolJson<QuoteResult>(
      await client.callTool({
        name: 'get_quote',
        arguments: {
          token_in: this.opts.pair.base,
          token_out: this.opts.pair.quote,
          amount,
          type: 'exact_in',
        },
      }),
    );
  }

  async getMarketData(): Promise<MarketData> {
    // A unit quote gives the spot (execution/mid) price of base in quote units.
    const q = await this.quote('1');
    const spotUsd = Number(q.midPrice ?? q.executionPrice ?? '0');

    let depthUsd = 0;
    if (this.opts.pairPackageHash) {
      const client = await this.ensureConnected();
      const d = parseToolJson<PairDetails>(
        await client.callTool({
          name: 'get_pair_details',
          arguments: { pair: this.opts.pairPackageHash },
        }),
      );
      // Use the quote-token side of the reserves as the (≈USD) depth.
      const quoteId = this.opts.pair.quote.toLowerCase();
      const isToken0 =
        d.token0?.symbol?.toLowerCase() === quoteId ||
        d.token0?.packageHash?.toLowerCase() === quoteId;
      const reserve = isToken0 ? d.reserve0 : d.reserve1;
      const decimals = (isToken0 ? d.token0?.decimals : d.token1?.decimals) ?? 0;
      if (reserve) depthUsd = Number(reserve) / 10 ** decimals;
    }
    return { spotUsd, depthUsd };
  }

  async priceImpactCurve(sizesUsd: number[]): Promise<PriceImpactSample[]> {
    // Convert each USD size to a base-token amount via spot, then read the quote's priceImpact.
    const spot = (await this.quote('1')).midPrice ?? (await this.quote('1')).executionPrice ?? '0';
    const spotNum = Number(spot) || 1;
    const out: PriceImpactSample[] = [];
    for (const sizeUsd of sizesUsd) {
      const baseAmount = (sizeUsd / spotNum).toFixed(6);
      const q = await this.quote(baseAmount);
      const bps = Math.round(Number(q.priceImpact ?? '0') * 100); // percent → bps
      out.push({ sizeUsd, bps });
    }
    return out;
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }
}

/** Static market data for tests / offline runs. */
export class StaticMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly data: MarketData,
    private readonly curve: PriceImpactSample[] = [],
  ) {}
  getMarketData(): Promise<MarketData> {
    return Promise.resolve(this.data);
  }
  priceImpactCurve(sizesUsd: number[]): Promise<PriceImpactSample[]> {
    if (this.curve.length > 0) return Promise.resolve(this.curve);
    // Linear toy model when no curve is supplied: 1 bps per $1k.
    return Promise.resolve(
      sizesUsd.map((sizeUsd) => ({ sizeUsd, bps: Math.round(sizeUsd / 1000) })),
    );
  }
}
