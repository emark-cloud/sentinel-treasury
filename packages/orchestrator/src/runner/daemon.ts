/**
 * Autonomous runner daemon — the missing trigger that makes the agent actually manage real deposits.
 *
 * It wires the live perception/decision/execution stack the loop already exposes, reconciles any
 * crash-interrupted deploys on startup, then every `RUNNER_INTERVAL_MS` enumerates the depositor set
 * and runs one bounded perceive→decide→act→prove cycle per account against their own ledger slice +
 * policy (`SentinelLoop.runForAccounts`). Each completed cycle is mapped to a `CycleView`, appended
 * to the history store, and streamed over the HTTP/SSE surface the dashboard reads. A tripped
 * circuit breaker submits the owner `pause(true)` kill switch (when the owner key is configured).
 *
 * Run: `pnpm --filter orchestrator start`. Requires (beyond the base registry) `AGENT_SECRET_KEY_PATH`.
 */
import { join } from 'node:path';
import type { RunnerStatus } from '@sentinel/shared';
import { loadConfig, loadEnv } from '../config/env.js';
import { loadRunnerConfig } from './config.js';
import { FileArtifactStore } from '../store/artifactStore.js';
import type { MarketSnapshot } from '@sentinel/shared';
import { ScriptedLlmClient } from '../llm/types.js';
import { GeminiClient } from '../llm/gemini.js';
import { RiskAgent } from '../agents/risk.js';
import { TreasuryAgent } from '../agents/treasury.js';
import { Scout } from '../agents/scout.js';
import { Deliberator, DecisionEngine } from '../decision/deliberate.js';
import type { DecisionInputs } from '../decision/types.js';
import { RpcOnChainReader } from '../data/onchainReader.js';
import { CsprTradeMcpProvider, StaticMarketDataProvider } from '../data/mcpClient.js';
import { CsprCloudClient, StaticBalanceReader } from '../data/csprCloud.js';
import type { PerceptionSources } from '../data/dataService.js';
import { RpcChainClient } from '../execution/chainClient.js';
import { PemFileSigner } from '../execution/signer.js';
import { FileCycleStore } from '../execution/cycleStore.js';
import { ExecutionService } from '../execution/executionService.js';
import { CircuitBreaker } from '../execution/circuitBreaker.js';
import { defaultRoutes, buildPauseTx } from '../execution/transaction.js';
import { AuditLogReceiptReader } from '../proof/receiptReader.js';
import { SentinelLoop } from '../loop.js';
import type { SentinelLoopDeps, SentinelLoopConfig } from '../loop.js';
import { FileCycleHistoryStore } from './cycleHistoryStore.js';
import { DepositorRegistry, AccountSource } from './accounts.js';
import { toCycleView } from './cycleView.js';
import { startRunnerServer } from './server.js';

/** Resolve a package hash to its active contract hash, falling back to the configured hash. */
async function resolveOrFallback(csprCloud: CsprCloudClient, packageHash: string): Promise<string> {
  try {
    return await csprCloud.resolveContractHash(packageHash);
  } catch {
    return packageHash;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const cfg = loadConfig();
  const runnerCfg = loadRunnerConfig();
  log(`starting runner — interval ${runnerCfg.intervalMs}ms, data ${runnerCfg.dataDir}`);

  if (!cfg.agentSecretKeyPath) {
    throw new Error('runner requires AGENT_SECRET_KEY_PATH (the bounded agent key signs execute_rebalance)');
  }

  // --- shared infra -------------------------------------------------------------------------
  const artifactStore = new FileArtifactStore(join(runnerCfg.dataDir, 'artifacts'));
  const chain = new RpcChainClient(cfg.nodeRpcUrl);
  const csprCloud = new CsprCloudClient({
    baseUrl: cfg.csprCloudBaseUrl,
    accessToken: cfg.csprCloudAccessToken,
  });

  // --- perception sources (live) -----------------------------------------------------------
  const [styksHash, stakingHash] = await Promise.all([
    resolveOrFallback(csprCloud, cfg.contracts.styks),
    resolveOrFallback(csprCloud, cfg.contracts.staking),
  ]);
  const onchain = new RpcOnChainReader(cfg.nodeRpcUrl, { styks: styksHash, staking: stakingHash });
  const marketData = cfg.csprTradeMcpEndpoint
    ? new CsprTradeMcpProvider({
        endpoint: cfg.csprTradeMcpEndpoint,
        pair: { base: cfg.contracts.staking, quote: cfg.contracts.stable },
      })
    : // Degraded fallback when no MCP endpoint: a neutral market so cycles run (mostly NoOp) rather
      // than throwing. Spot tracks the configured display TWAP; depth is generous.
      new StaticMarketDataProvider({ spotUsd: 0.0307, depthUsd: 100_000 });
  const sources: PerceptionSources = {
    priceFeed: onchain,
    exchangeRate: onchain,
    marketData,
    // Per-account balances override this in runForAccounts; the aggregate source is unused there.
    balances: new StaticBalanceReader({ cspr: '0', scspr: '0', csprusd: '0' }),
  };

  // --- decision stack ----------------------------------------------------------------------
  const llm = cfg.gemini.apiKey
    ? new GeminiClient({ apiKey: cfg.gemini.apiKey, model: cfg.gemini.model })
    : new ScriptedLlmClient([]); // no key → every turn falls back to the deterministic rule engine
  const deliberator = new Deliberator(
    new RiskAgent(llm, runnerCfg.policy),
    new TreasuryAgent(llm),
    runnerCfg.policy,
  );
  const decisionEngine = new DecisionEngine(deliberator, artifactStore);

  // --- execution ---------------------------------------------------------------------------
  const signer = new PemFileSigner(cfg.agentSecretKeyPath, cfg.agentPublicKey);
  const cycleStore = new FileCycleStore(join(runnerCfg.dataDir, 'cycles'));
  const execution = new ExecutionService(chain, signer, cycleStore, {
    chainName: cfg.network,
    vaultPackageHash: cfg.contracts.vault,
    routes: defaultRoutes({
      scspr: cfg.contracts.staking,
      wcspr: cfg.contracts.wcspr,
      stable: cfg.contracts.stable,
    }),
    paymentMotes: cfg.execution.rebalancePaymentMotes,
    pollIntervalMs: cfg.execution.pollIntervalMs,
    pollTimeoutMs: cfg.execution.pollTimeoutMs,
  });
  const breaker = new CircuitBreaker({ maxConsecutiveReverts: cfg.execution.maxConsecutiveReverts });

  // --- loop --------------------------------------------------------------------------------
  const decisionInputs: DecisionInputs = {
    exchangeRate: runnerCfg.exchangeRateFallback,
    policy: runnerCfg.policy,
    targets: { router: cfg.contracts.router, staking: cfg.contracts.staking },
  };
  const loopDeps: SentinelLoopDeps = {
    sources,
    scout: new Scout(artifactStore),
    decisionEngine,
    execution,
    circuitBreaker: breaker,
    store: artifactStore,
  };
  const loopCfg: SentinelLoopConfig = {
    decisionInputs,
    oracleGuard: {
      maxHeartbeatAgeSec: cfg.execution.maxHeartbeatAgeSec,
      maxDivergenceBps: cfg.execution.maxDivergenceBps,
    },
  };
  const loop = new SentinelLoop(loopDeps, loopCfg);

  // --- runner state + feeds ----------------------------------------------------------------
  const history = new FileCycleHistoryStore(join(runnerCfg.dataDir, 'history.json'));
  await history.load();
  const registry = new DepositorRegistry(join(runnerCfg.dataDir, 'depositors.json'));
  await registry.load(runnerCfg.accountSeed);
  await registry.persist();
  const accountSource = new AccountSource({
    chain,
    csprCloud,
    registry,
    vaultPackageHash: cfg.contracts.vault,
    policy: runnerCfg.policy,
    skipEmpty: runnerCfg.skipEmpty,
  });

  const state = {
    running: false,
    lastRunAt: null as number | null,
    nextRunAt: null as number | null,
    accountCount: 0,
  };
  const status = (): RunnerStatus => ({
    running: state.running,
    paused: breaker.isTripped,
    breakerTripped: breaker.isTripped,
    lastRunAt: state.lastRunAt,
    nextRunAt: state.nextRunAt,
    intervalMs: runnerCfg.intervalMs,
    accountCount: state.accountCount,
  });

  // On-chain AuditLog reader — the verifiable receipt backbone the dashboard reads (and verifies
  // by recomputing perception/decision hashes). Keyed by the active AuditLog contract hash.
  const auditLogHash = await resolveOrFallback(csprCloud, cfg.contracts.auditLog);
  const receiptReader = new AuditLogReceiptReader(chain, auditLogHash);

  const { port } = await startRunnerServer(
    {
      history,
      getStatus: status,
      getReceipts: (limit) => receiptReader.latest(limit),
    },
    runnerCfg.httpPort,
  );
  log(`HTTP/SSE on :${port} (/status, /cycles, /cycles/stream, /receipts)`);

  // --- the batch ---------------------------------------------------------------------------
  async function runBatch(): Promise<void> {
    if (state.running) return; // never overlap batches
    state.running = true;
    const startedAt = Date.now();
    const cycleId = `cycle-${startedAt}`;
    try {
      const accounts = await accountSource.listAccounts();
      state.accountCount = accounts.length;
      if (accounts.length === 0) {
        log('no depositor accounts to manage this batch');
        return;
      }
      const results = await loop.runForAccounts(accounts, { cycleId, now: startedAt });

      for (const result of results) {
        if (result.circuit?.shouldPause) await tripOwnerPause(result.circuit.reason);
        if (!result.decision || !result.perceptionHash) continue;
        const stored = await artifactStore.getByHash<MarketSnapshot>(result.perceptionHash);
        if (!stored) continue;
        const view = toCycleView({
          result,
          snapshot: stored.artifact,
          agent: cfg.agentPublicKey,
          startedAt,
          source: 'live',
        });
        if (view) await history.append(view);
      }
      const acted = results.filter((r) => r.acted).length;
      log(`batch ${cycleId}: ${accounts.length} accounts, ${acted} acted`);
    } catch (err) {
      log(`batch ${cycleId} error: ${(err as Error).message}`);
    } finally {
      state.lastRunAt = Date.now();
      state.nextRunAt = state.lastRunAt + runnerCfg.intervalMs;
      state.running = false;
    }
  }

  /** Submit the owner `pause(true)` kill switch once when the breaker trips (owner key required). */
  async function tripOwnerPause(reason?: string): Promise<void> {
    log(`circuit breaker tripped${reason ? `: ${reason}` : ''}`);
    if (!cfg.ownerSecretKeyPath) {
      log('OWNER_SECRET_KEY_PATH not set — cannot submit pause(true); breaker blocks new cycles locally');
      return;
    }
    try {
      const ownerSigner = new PemFileSigner(cfg.ownerSecretKeyPath, cfg.ownerPublicKey);
      const tx = buildPauseTx({
        ownerPublicKeyHex: cfg.ownerPublicKey,
        vaultPackageHash: cfg.contracts.vault,
        chainName: cfg.network,
        paymentMotes: cfg.execution.pausePaymentMotes,
        paused: true,
      });
      ownerSigner.sign(tx);
      const hash = await chain.submit(tx);
      log(`submitted owner pause(true): ${hash}`);
    } catch (err) {
      log(`failed to submit owner pause: ${(err as Error).message}`);
    }
  }

  // --- startup: reconcile in-flight deploys, then run + schedule ----------------------------
  try {
    const settled = await execution.reconcile();
    if (settled.length > 0) log(`reconciled ${settled.length} in-flight deploy(s) on startup`);
  } catch (err) {
    log(`reconcile error: ${(err as Error).message}`);
  }

  await runBatch();
  const timer = setInterval(() => void runBatch(), runnerCfg.intervalMs);

  const shutdown = (sig: string): void => {
    log(`${sig} — shutting down`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function log(msg: string): void {
  process.stdout.write(`[runner ${new Date().toISOString()}] ${msg}\n`);
}

main().catch((err) => {
  process.stderr.write(`[runner] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
