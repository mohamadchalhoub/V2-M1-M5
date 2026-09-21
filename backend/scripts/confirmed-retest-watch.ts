/**
 * scripts/confirmed-retest-watch.ts — WATCH-ONLY research watcher for
 * `xauusd-h4-confirmed-retest-v1`.
 *
 * Reads stored, settled XAUUSD bars (written by the collector), advances the
 * persisted replay state, journals forward observations and writes a status
 * summary for the dashboard. It has no order path, never writes to the
 * database and does not fetch broker data itself.
 *
 * Persistent watcher (one command):  npm run confirmed-retest:watcher
 * One cycle:                          npm run confirmed-retest:watch
 * Bounded run:                        npm run confirmed-retest:watch -- --interval-seconds 60 --max-cycles 3
 * Volume (user-only, audited):        npm run confirmed-retest:watch -- --set-volume-lots 0.01 --changed-by "<name>"
 *
 * Restart-safe: state is persisted after every cycle; a single-instance
 * process lock prevents overlapping watchers; transient errors (database
 * down, collector stopped) back off and retry without exiting.
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { latestCompletedM1CloseUtc } from '../src/research/confirmed-retest/data-source';
import { executeRun, loadAll } from '../src/research/confirmed-retest/pipeline';
import { SPEC } from '../src/research/confirmed-retest/spec';
import { iso } from '../src/research/confirmed-retest/time';
import { ORDER_EXECUTION, ProcessLock, setVolume, shadowSimulations, WatchStore } from '../src/research/confirmed-retest/watch';
import { runWatchCycle, type WatcherDeps } from '../src/research/confirmed-retest/watcher';

const STATE_DIR = resolve(process.env.RESEARCH_STATE_DIR ?? resolve(__dirname, '..', 'research-state'), SPEC.version);
const MAX_ERROR_BACKOFF_MS = 15 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function prismaDeps(prisma: PrismaClient): WatcherDeps {
  return {
    now: () => Date.now(),
    latestM1CloseT: () => latestCompletedM1CloseUtc(prisma, SPEC.symbol),
    readQuotes: async () =>
      (await prisma.liveTick.findMany({ where: { symbol: { in: [SPEC.symbol, 'EURUSD'] } } })).map((r) => ({
        symbol: r.symbol,
        bid: Number(r.bid),
        ask: Number(r.ask),
        tickAtT: r.tickAt.getTime(),
        receivedAtT: r.updatedAt.getTime(),
      })),
    readSymbolMetadata: async () => {
      const m = await prisma.symbolMetadata.findUnique({ where: { symbol: SPEC.symbol } });
      return m ? { digits: m.digits, tradeTickSize: Number(m.tradeTickSize ?? m.point) } : null;
    },
    readCollectorHeartbeat: async () => {
      const h = await prisma.collectorHeartbeat.findFirst({ orderBy: { lastHeartbeatAt: 'desc' } });
      return h ? { lastHeartbeatT: h.lastHeartbeatAt.getTime(), mt5Connected: h.mt5Connected } : null;
    },
    advanceReplay: async (state, endT, observedAtT) => {
      const loaded = await loadAll(prisma, endT);
      const run = executeRun(loaded, { state: state ?? undefined, observedAtT });
      return { state: run.state, dataHash: loaded.dataHash, run };
    },
    computeShadow: (run, state) => shadowSimulations(run as Parameters<typeof shadowSimulations>[0], state).map((s) => s.summary),
  };
}

async function main(): Promise<void> {
  const loop = process.argv.includes('--loop') || arg('interval-seconds') !== undefined;
  const intervalMs = Math.max(30, Number(arg('interval-seconds') ?? 300)) * 1000;
  const maxCycles = arg('max-cycles') ? Number(arg('max-cycles')) : loop ? Infinity : 1;
  const prisma = new PrismaClient();
  const store = new WatchStore(STATE_DIR);
  const lock = new ProcessLock(store.processLockPath, Math.max(15 * 60_000, 3 * intervalMs));
  const { tookOverFrom } = lock.acquire(Date.now());
  if (tookOverFrom) store.journal({ type: 'STALE_LOCK_TAKEN_OVER', previous: tookOverFrom });

  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = (signal: string) => {
    stopping = true;
    store.journal({ type: 'WATCHER_STOP_REQUESTED', signal });
    wake?.();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const deps = prismaDeps(prisma);
  const startedAtUtc = new Date().toISOString();
  store.journal({ type: 'WATCHER_STARTED', pid: process.pid, loop, intervalSeconds: intervalMs / 1000, orderExecution: ORDER_EXECUTION });
  let consecutiveErrors = 0;
  let cycles = 0;
  try {
    const volume = arg('set-volume-lots');
    if (volume !== undefined) {
      const state = store.load(Date.now());
      const entry = setVolume(state, Number(volume), arg('changed-by') ?? '', Date.now());
      store.save(state);
      store.journal({ type: 'VOLUME_CHANGE', ...entry });
    }

    while (!stopping && cycles < maxCycles) {
      cycles += 1;
      let delayMs = intervalMs;
      try {
        lock.heartbeat(Date.now());
        const result = await runWatchCycle(store, deps);
        consecutiveErrors = 0;
        console.log(`[watcher ${SPEC.version}] cycle ${cycles}: ${result.evaluation} — ${result.reason}; orders: ${ORDER_EXECUTION}`);
        store.writeSummary({ ...result.summary, watcher: { pid: process.pid, startedAtUtc, cycle: cycles, loop, intervalSeconds: intervalMs / 1000, consecutiveErrors, lastError: null, nextCycleAtUtc: loop && cycles < maxCycles ? iso(Date.now() + intervalMs) : null } });
      } catch (err) {
        consecutiveErrors += 1;
        delayMs = Math.min(MAX_ERROR_BACKOFF_MS, 30_000 * 2 ** (consecutiveErrors - 1));
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[watcher] cycle ${cycles} failed (${consecutiveErrors} in a row), retrying in ${delayMs / 1000}s: ${message}`);
        store.journal({ type: 'CYCLE_ERROR', cycle: cycles, consecutiveErrors, error: message });
        if (message.includes('process lock was lost') || message.includes('Refusing to mix rule versions')) throw err;
      }
      if (stopping || cycles >= maxCycles) break;
      await new Promise<void>((r) => {
        const t = setTimeout(r, delayMs);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
  } finally {
    store.journal({ type: 'WATCHER_EXITED', cycles, consecutiveErrors });
    lock.release();
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
