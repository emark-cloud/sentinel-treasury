import { describe, it, expect } from 'vitest';
import type { ChainClient, TxStatus } from '../src/execution/chainClient.js';
import type { TxSigner } from '../src/execution/signer.js';
import type { Clock } from '../src/execution/executionService.js';
import type { SwapRoutes } from '../src/execution/transaction.js';
import { ByteWriter } from '../src/execution/clbytes.js';
import { odraDictionaryItemKey } from '../src/data/onchainReader.js';
import { ExecutionService } from '../src/execution/executionService.js';
import { MemoryCycleStore } from '../src/execution/cycleStore.js';
import { CircuitBreaker } from '../src/execution/circuitBreaker.js';
import { MemoryArtifactStore } from '../src/store/artifactStore.js';
import { ScriptedLlmClient } from '../src/llm/types.js';
import { RiskAgent } from '../src/agents/risk.js';
import { TreasuryAgent } from '../src/agents/treasury.js';
import { Deliberator, DecisionEngine } from '../src/decision/deliberate.js';
import { Scout } from '../src/agents/scout.js';
import type { DecisionInputs, DecisionPolicy } from '../src/decision/types.js';
import { SentinelLoop } from '../src/loop.js';
import type { SentinelLoopDeps, SentinelLoopConfig, AccountContext } from '../src/loop.js';
import { buildScenario, demoBalances } from '../src/scenario/scenarios.js';
import type { MarketSnapshot, VaultBalances } from '@sentinel/shared';
import { LEDGER_FIELD_INDEX, readAccountLedger, toAccountHashHex } from '../src/runner/accountLedgerReader.js';
import { AccountSource, DepositorRegistry } from '../src/runner/accounts.js';
import { MemoryCycleHistoryStore } from '../src/runner/cycleHistoryStore.js';
import { toCycleView } from '../src/runner/cycleView.js';
import type { CsprCloudClient } from '../src/data/csprCloud.js';

const AGENT_PK = '01a4e9a55d4546c2e3d11643b6cdf3192a4c6db36b987704afd6e0d88009309fd6';
const h32 = (b: string) => b.repeat(32);

const POLICY: DecisionPolicy = {
  perActionCapUsd: 250,
  dailyCapUsd: 1000,
  dayRemainingUsd: 1000,
  maxSlippageBps: 100,
  minScsprBps: 1000,
  maxScsprBps: 7000,
  csprBufferCspr: 75,
  minTradeUsd: 1,
};
const routes: SwapRoutes = {
  swapToStable: [h32('aa'), h32('bb'), h32('cc')],
  swapToRisk: [h32('cc'), h32('bb'), h32('aa')],
};
const TARGETS = { router: h32('cc'), staking: h32('dd') };

/** A chain whose dictionary returns encoded U256 ledger slots for one known account hash. */
class FakeLedgerChain implements ChainClient {
  slots = new Map<string, Uint8Array>();
  constructor(private readonly contractHash: string) {}
  setSlot(accountHashHex: string, fieldIndex: number, value: bigint): void {
    const mapKey = new ByteWriter().accountAddress(accountHashHex).finish();
    const key = odraDictionaryItemKey(fieldIndex, mapKey);
    this.slots.set(key, new ByteWriter().uint(value).finish());
  }
  submit(): Promise<string> {
    return Promise.resolve(h32('de'));
  }
  getStatus(): Promise<TxStatus | null> {
    return Promise.resolve({ finalized: true, success: true });
  }
  getDictionaryBytes(
    contractHash: string,
    _dict: string,
    itemKey: string,
  ): Promise<Uint8Array | null> {
    if (contractHash !== this.contractHash) return Promise.resolve(null);
    return Promise.resolve(this.slots.get(itemKey) ?? null);
  }
}

describe('accountLedgerReader', () => {
  it('derives an account hash from a public key and reads its ledger slice', async () => {
    const accountHash = toAccountHashHex(AGENT_PK)!;
    expect(accountHash).toMatch(/^[0-9a-f]{64}$/);

    const chain = new FakeLedgerChain('cc');
    chain.setSlot(accountHash, LEDGER_FIELD_INDEX.cspr, 1_000_000_000n);
    chain.setSlot(accountHash, LEDGER_FIELD_INDEX.scspr, 42n);
    chain.setSlot(accountHash, LEDGER_FIELD_INDEX.csprusd, 7_500_000n);

    const balances = await readAccountLedger(chain, 'cc', AGENT_PK);
    expect(balances).toEqual({ cspr: '1000000000', scspr: '42', csprusd: '7500000' });
  });

  it('returns null for a non-chain (demo) account and zeros for an untouched ledger', async () => {
    expect(await readAccountLedger(new FakeLedgerChain('cc'), 'cc', 'demo-abc')).toBeNull();
    const empty = await readAccountLedger(new FakeLedgerChain('cc'), 'cc', h32('ac'));
    expect(empty).toEqual({ cspr: '0', scspr: '0', csprusd: '0' });
  });
});

describe('DepositorRegistry + AccountSource', () => {
  it('merges seed + discovery, dedupes, and skips empty ledgers', async () => {
    const seedAcct = h32('11');
    const discoveredAcct = h32('22');
    const contractHash = 'cc';
    const chain = new FakeLedgerChain(contractHash);
    chain.setSlot(seedAcct, LEDGER_FIELD_INDEX.cspr, 500n); // funded
    // discoveredAcct left empty → skipped when skipEmpty

    const registry = new DepositorRegistry('/tmp/sentinel-test-registry-does-not-persist.json');
    // load() reads no file (path absent) and merges the seed.
    await registry.load([seedAcct]).catch(() => undefined);

    const csprCloud = {
      listDepositorAccountHashes: () => Promise.resolve([discoveredAcct]),
      resolveContractHash: () => Promise.resolve(contractHash),
    } as unknown as CsprCloudClient;

    const source = new AccountSource({
      chain,
      csprCloud,
      registry,
      vaultPackageHash: h32('11'),
      policy: POLICY,
      skipEmpty: true,
    });
    const accounts = await source.listAccounts();
    expect(accounts.map((a) => a.accountHashHex)).toEqual([seedAcct]);
    expect(accounts[0]!.balances.cspr).toBe('500');
    expect(accounts[0]!.policy).toBe(POLICY);
  });
});

describe('MemoryCycleHistoryStore', () => {
  it('appends newest-first, bounds to cap, and notifies subscribers', async () => {
    const store = new MemoryCycleHistoryStore(2);
    const seen: string[] = [];
    const unsub = store.subscribe((c) => seen.push(c.id));
    const mk = (id: string) => ({ id }) as never;
    await store.append(mk('a'));
    await store.append(mk('b'));
    await store.append(mk('c'));
    const recent = await store.recent(10);
    expect(recent.map((c) => c.id)).toEqual(['c', 'b']); // newest first, capped at 2
    expect(seen).toEqual(['a', 'b', 'c']);
    unsub();
    await store.append(mk('d'));
    expect(seen).toEqual(['a', 'b', 'c']); // no more notifications after unsubscribe
  });
});

/** Build a scenario-driven loop (deterministic fallback path; no network) for the mapping test. */
function makeLoop(balances: VaultBalances): {
  loop: SentinelLoop;
  store: MemoryArtifactStore;
  scn: ReturnType<typeof buildScenario>;
} {
  const scn = buildScenario('price-shock', { balances, nowSec: 1_000_000 });
  const store = new MemoryArtifactStore();
  const llm = new ScriptedLlmClient([]);
  const deliberator = new Deliberator(new RiskAgent(llm, POLICY), new TreasuryAgent(llm), POLICY);
  const decisionEngine = new DecisionEngine(deliberator, store);
  const signer: TxSigner = { publicKeyHex: AGENT_PK, sign: () => {} };
  const clock: Clock = { now: () => 1000, sleep: () => Promise.resolve() };
  const chain: ChainClient = {
    submit: () => Promise.resolve(h32('de')),
    getStatus: () => Promise.resolve({ finalized: true, success: true }),
    getDictionaryBytes: () => Promise.resolve(null),
  };
  const execution = new ExecutionService(
    chain,
    signer,
    new MemoryCycleStore(),
    { chainName: 'casper-test', vaultPackageHash: h32('11'), routes, paymentMotes: 1, pollIntervalMs: 1, pollTimeoutMs: 1 },
    clock,
  );
  const deps: SentinelLoopDeps = {
    sources: scn.sources,
    scout: new Scout(store),
    decisionEngine,
    execution,
    circuitBreaker: new CircuitBreaker({ maxConsecutiveReverts: 3 }),
    store,
  };
  const decisionInputs: DecisionInputs = { exchangeRate: 1.052, policy: POLICY, targets: TARGETS };
  const cfg: SentinelLoopConfig = {
    decisionInputs,
    oracleGuard: { maxHeartbeatAgeSec: 5400, maxDivergenceBps: 500 },
  };
  return { loop: new SentinelLoop(deps, cfg), store, scn };
}

describe('toCycleView', () => {
  it('maps a real acted cycle into a transport CycleView with a verifiable receipt', async () => {
    const balances = demoBalances({ scsprBps: 6000, twapUsd: 0.0304 });
    const account: AccountContext = { accountHashHex: h32('ac'), balances, policy: POLICY };
    const { loop, store, scn } = makeLoop(balances);
    const [result] = await loop.runForAccounts([account], {
      cycleId: 'cyc-shock',
      premium: scn.premium,
      volatility: scn.volatility,
      now: 1_000_000_000,
    });

    expect(result!.stage).toBe('acted');
    const snap = await store.getByHash<MarketSnapshot>(result!.perceptionHash!);
    const view = toCycleView({
      result: result!,
      snapshot: snap!.artifact,
      agent: AGENT_PK,
      startedAt: 1_000_000_000,
      source: 'live',
    });

    expect(view).not.toBeNull();
    expect(view!.source).toBe('live');
    expect(view!.account).toBe(h32('ac'));
    expect(view!.regime).toBe('Stressed');
    expect(view!.decisionHash).toBe(result!.decisionHash);
    expect(view!.receipt.deployHash).toBe(h32('de'));
    expect(view!.receipt.actionKind).toBe('SwapToStable');
    // receipt mirrors the on-chain perception/decision hashes (the verify backbone).
    expect(view!.receipt.perceptionHash).toBe(result!.perceptionHash);
    expect(view!.receipt.account).toBe(h32('ac'));
  });
});
