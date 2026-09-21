// Spec §10 watch-only workflow: idempotent restarts, no daily/level reset,
// timestamp-basis blocking, metadata blocking, stale-data reporting, and the
// single-instance process lock. Fully in-memory — no database, no terminal.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advance, createReplayState, type ReplayState } from '../../../src/research/confirmed-retest/replay';
import { ProcessLock, WatchStore } from '../../../src/research/confirmed-retest/watch';
import { liveTimestampCheck, runWatchCycle, type QuoteRow, type WatcherDeps } from '../../../src/research/confirmed-retest/watcher';
import { M1, h4Series } from './helpers';

const START = '2025-01-06T00:00:00.000Z';
const START_T = Date.parse(START);

function newStore() {
  return new WatchStore(mkdtempSync(join(tmpdir(), 'crt-watcher-')));
}

/** A deterministic in-memory "database": fixed H4 bars, M1 bars advancing one per call, plus quotes/metadata/heartbeat the test controls. */
function fakeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps & { setNow(t: number): void; setQuotes(q: QuoteRow[]): void; m1Count: number } {
  const h4 = h4Series(START, 40, { 3: { h: 2100 }, 13: { h: 2100 } });
  const BASE_OFFSET_MS = 70 * 3_600_000; // after the H4 confirmation at bar 15 (closes at +64h)
  const box = { nowT: START_T + BASE_OFFSET_MS, quotes: [] as QuoteRow[], m1Count: 0 };

  const obj = {
    now: () => box.nowT,
    setNow: (t: number) => (box.nowT = t),
    setQuotes: (q: QuoteRow[]) => (box.quotes = q),
    get m1Count() {
      return box.m1Count;
    },
    set m1Count(v: number) {
      box.m1Count = v;
    },
    latestM1CloseT: async () => (box.m1Count === 0 ? null : START_T + BASE_OFFSET_MS + box.m1Count * M1),
    readQuotes: async () => box.quotes,
    readSymbolMetadata: async () => ({ digits: 2, tradeTickSize: 0.01 }),
    readCollectorHeartbeat: async () => ({ lastHeartbeatT: box.nowT - 5_000, mt5Connected: true }),
    advanceReplay: async (state: ReplayState | null, endT: number, observedAtT: number | null) => {
      const bars = Array.from({ length: box.m1Count }, (_, i) => {
        const t = START_T + BASE_OFFSET_MS + i * M1;
        return { t, dur: M1, o: 210000, h: 210000, l: 209900, c: 210000, res: 'M1' as const, gapBefore: null };
      });
      const s = state ?? createReplayState(START_T);
      advance(s, { h4, d1: [], stream: bars }, { endT, observedAtT });
      return { state: s, dataHash: `hash-${box.m1Count}`, run: { s } };
    },
    computeShadow: () => ({ ok: true }),
    ...overrides,
  };
  return obj as typeof obj & WatcherDeps;
}

describe('restart and idempotency', () => {
  it('bootstrap does not journal forward observations; a later cycle with new data does, exactly once even if replayed', async () => {
    const store = newStore();
    const deps = fakeDeps();
    deps.m1Count = 1; // one settled bar available at bootstrap
    const first = await runWatchCycle(store, deps);
    expect(first.evaluation).toBe('EVALUATED_NEW_DATA');

    deps.m1Count = 2; // one new bar
    deps.setNow(deps.now() + 5 * 60_000);
    const second = await runWatchCycle(store, deps);
    expect(second.evaluation).toBe('EVALUATED_NEW_DATA');

    const journalLines = readFileSync(store.journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bootstrapEntries = journalLines.filter((l) => l.type === 'BOOTSTRAP');
    expect(bootstrapEntries).toHaveLength(1);

    // Re-run journalOnce reconciliation (simulating a restart after the crash-between-save-and-journal window) — no duplicate keys.
    store.journalOnce('bootstrap', { type: 'BOOTSTRAP', settledEndUtc: 'x' });
    const after = readFileSync(store.journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(after.filter((l) => l.type === 'BOOTSTRAP')).toHaveLength(1);
  });

  it('re-running a cycle with no new settled data changes nothing and is reported as such', async () => {
    const store = newStore();
    const deps = fakeDeps();
    deps.m1Count = 1;
    await runWatchCycle(store, deps);
    const stateAfterFirst = readFileSync(store.statePath, 'utf8');

    deps.setNow(deps.now() + 60_000);
    const result = await runWatchCycle(store, deps); // same m1Count, no new data
    expect(result.evaluation).toBe('WAITING_FOR_NEW_COMPLETED_DATA');
    expect(readFileSync(store.statePath, 'utf8')).not.toBe(stateAfterFirst); // lastCycleAtUtc updates
    const state = JSON.parse(readFileSync(store.statePath, 'utf8'));
    expect(state.replay.eventOrder).toEqual(JSON.parse(stateAfterFirst).replay.eventOrder); // replay itself is untouched
  });

  it('does not reset level eligibility across a restart or a new calendar day', async () => {
    const store = newStore();
    const deps = fakeDeps();
    deps.m1Count = 1;
    await runWatchCycle(store, deps);
    const activeBefore = JSON.parse(readFileSync(store.statePath, 'utf8')).replay.levels.activeLevelIds;
    expect(activeBefore.length).toBeGreaterThan(0);

    // Simulate a restart a full day later with no new data: a fresh WatchStore instance over the same directory.
    const restarted = new WatchStore(store.dir);
    deps.setNow(deps.now() + 25 * 3_600_000);
    const result = await runWatchCycle(restarted, deps);
    expect(result.evaluation).toBe('WAITING_FOR_NEW_COMPLETED_DATA');
    const activeAfter = JSON.parse(readFileSync(restarted.statePath, 'utf8')).replay.levels.activeLevelIds;
    expect(activeAfter).toEqual(activeBefore);
  });

  it('refuses to resume a state file written under a different spec hash', async () => {
    const store = newStore();
    const deps = fakeDeps();
    deps.m1Count = 1;
    await runWatchCycle(store, deps);
    const state = JSON.parse(readFileSync(store.statePath, 'utf8'));
    state.specHash = 'not-the-current-spec';
    require('node:fs').writeFileSync(store.statePath, JSON.stringify(state));
    await expect(runWatchCycle(new WatchStore(store.dir), deps)).rejects.toThrow(/Refusing to mix rule versions/);
  });
});

describe('timestamp-basis blocking', () => {
  it('a live receipt-minus-tick delay far outside the recorded conversion blocks evaluation but not raw collection', async () => {
    const store = newStore();
    const deps = fakeDeps();
    deps.m1Count = 1;
    deps.setQuotes([{ symbol: 'XAUUSD', bid: 2500, ask: 2500.5, tickAtT: deps.now() - 3 * 3_600_000, receivedAtT: deps.now() }]);
    const result = await runWatchCycle(store, deps);
    expect(result.evaluation).toBe('BLOCKED_TIMESTAMP_CONTRADICTED');
    expect(result.summary).toMatchObject({ evaluation: { status: 'BLOCKED_TIMESTAMP_CONTRADICTED' } });
    // Held, not advanced: a subsequent good cycle still evaluates from scratch (no state was corrupted).
    deps.setQuotes([]);
    deps.setNow(deps.now() + 60_000);
    const recovered = await runWatchCycle(store, deps);
    expect(recovered.evaluation).toBe('EVALUATED_NEW_DATA');
  });

  it('no quote at all is reported as unavailable, not contradicted, and evaluation proceeds', async () => {
    const store = newStore();
    const deps = fakeDeps();
    deps.m1Count = 1;
    const result = await runWatchCycle(store, deps);
    expect(result.evaluation).toBe('EVALUATED_NEW_DATA');
    expect((result.summary as any).timestampVerification.live.status).toBe('LIVE_UNAVAILABLE');
  });

  it('liveTimestampCheck classifies a consistent, a contradicted and an unavailable quote', () => {
    const t = 1_000_000_000;
    expect(liveTimestampCheck([{ symbol: 'XAUUSD', bid: 1, ask: 1, tickAtT: t - 2000, receivedAtT: t }], t).status).toBe('LIVE_CONSISTENT');
    expect(liveTimestampCheck([{ symbol: 'XAUUSD', bid: 1, ask: 1, tickAtT: t - 3 * 3_600_000, receivedAtT: t }], t).status).toBe('LIVE_CONTRADICTED');
    expect(liveTimestampCheck([{ symbol: 'XAUUSD', bid: 1, ask: 1, tickAtT: t - 20 * 60_000, receivedAtT: t - 20 * 60_000 }], t).status).toBe('LIVE_UNAVAILABLE');
  });
});

describe('metadata and staleness', () => {
  it('missing symbol metadata blocks evaluation', async () => {
    const store = newStore();
    const deps = fakeDeps({ readSymbolMetadata: async () => null });
    deps.m1Count = 1;
    const result = await runWatchCycle(store, deps);
    expect(result.evaluation).toBe('BLOCKED_METADATA_MISSING');
  });

  it('a mismatched tick size/digits blocks evaluation', async () => {
    const store = newStore();
    const deps = fakeDeps({ readSymbolMetadata: async () => ({ digits: 3, tradeTickSize: 0.001 }) });
    deps.m1Count = 1;
    const result = await runWatchCycle(store, deps);
    expect(result.evaluation).toBe('BLOCKED_METADATA_MISMATCH');
  });

  it('no gold data at all is reported distinctly from a stale feed', async () => {
    const store = newStore();
    const deps = fakeDeps();
    const result = await runWatchCycle(store, deps);
    expect(result.evaluation).toBe('NO_GOLD_DATA');
    expect((result.summary as any).goldData.stale).toBe(true);
  });

  it('a collector heartbeat that has gone silent is surfaced in the summary', async () => {
    const store = newStore();
    const deps = fakeDeps();
    const silentHeartbeatT = deps.now() - 3600_000;
    const withSilentHeartbeat = fakeDeps({ readCollectorHeartbeat: async () => ({ lastHeartbeatT: silentHeartbeatT, mt5Connected: false }) });
    withSilentHeartbeat.m1Count = 1;
    const result = await runWatchCycle(store, withSilentHeartbeat);
    expect((result.summary as any).collector).toMatchObject({ mt5Connected: false });
    expect((result.summary as any).collector.ageSeconds).toBeGreaterThan(3000);
  });
});

describe('single-instance process lock', () => {
  it('a second lock attempt while the first is fresh is refused; a stale lock is taken over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crt-lock-'));
    const path = join(dir, 'watcher.process.lock');
    const alwaysAlive = () => true;
    const lockA = new ProcessLock(path, 15 * 60_000, alwaysAlive);
    lockA.acquire(1_000, 111);
    const lockB = new ProcessLock(path, 15 * 60_000, alwaysAlive);
    expect(() => lockB.acquire(2_000, 222)).toThrow(/another research watcher is running/);

    // Stale: heartbeat older than staleAfterMs.
    const { tookOverFrom } = lockB.acquire(1_000 + 16 * 60_000, 222);
    expect(tookOverFrom).toMatchObject({ pid: 111 });
  });

  it('a lock whose owning pid is no longer alive is taken over immediately, even if fresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crt-lock-'));
    const path = join(dir, 'watcher.process.lock');
    new ProcessLock(path, 15 * 60_000, () => true).acquire(1_000, 111);
    const { tookOverFrom } = new ProcessLock(path, 15 * 60_000, () => false).acquire(1_001, 222);
    expect(tookOverFrom).toMatchObject({ pid: 111 });
  });

  it('heartbeat refreshes the lock; release only removes a lock this process still owns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crt-lock-'));
    const path = join(dir, 'watcher.process.lock');
    const lock = new ProcessLock(path, 15 * 60_000, () => true);
    lock.acquire(1_000, 111);
    lock.heartbeat(5_000, 111);
    expect(lock.read()?.heartbeatT).toBe(5_000);
    lock.release(111);
    expect(lock.read()).toBeNull();
  });
});
