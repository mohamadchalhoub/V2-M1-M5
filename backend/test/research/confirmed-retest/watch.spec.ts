// Spec §10 watch-only safety: quote gate, persisted-state integrity, locking, volume audit.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC_HASH } from '../../../src/research/confirmed-retest/spec';
import type { FirstReturnEvent } from '../../../src/research/confirmed-retest/types';
import { evaluateQuoteGate, newWatchState, setVolume, WatchStore } from '../../../src/research/confirmed-retest/watch';
import { usd } from './helpers';

const NOW = Date.parse('2026-09-15T05:00:00.000Z');
const buy = { id: 'evt:x', direction: 'BUY', levelPrice: usd(2500) } as FirstReturnEvent;
const quote = (bid: number, ask: number, ageMs: number) => ({ bid: usd(bid), ask: usd(ask), tickT: NOW - ageMs, readAtT: NOW });

describe('shadow quote gate', () => {
  it('passes a fresh, tight quote within $1 of the level (BUY uses ask)', () => {
    expect(evaluateQuoteGate(buy, quote(2500.2, 2500.5, 4_000), NOW)).toMatchObject({ pass: true, executablePrice: usd(2500.5) });
  });
  it.each([
    ['no quote', null, 'QUOTE_UNAVAILABLE'],
    ['older than 5 s', quote(2500, 2500.2, 5_001), 'QUOTE_STALE_OVER_5S'],
    ['future-dated', quote(2500, 2500.2, -60_000), 'QUOTE_TIMESTAMP_IN_FUTURE_TIME_BASIS_UNVERIFIED'],
    ['spread over $1', quote(2499.4, 2500.41, 1_000), 'SPREAD_OVER_1_USD'],
    ['ask more than $1 from level', quote(2500.9, 2501.01, 1_000), 'EXECUTABLE_PRICE_OVER_1_USD_FROM_LEVEL'],
  ])('rejects %s', (_label, q, reason) => {
    expect(evaluateQuoteGate(buy, q, NOW)).toMatchObject({ pass: false, reason });
  });
});

describe('persisted watch state', () => {
  it('refuses to resume state written under a different spec hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crt-watch-'));
    const store = new WatchStore(dir);
    writeFileSync(store.statePath, JSON.stringify({ ...newWatchState(NOW), specHash: 'old-spec' }));
    expect(() => store.load(NOW)).toThrow(/Refusing to mix rule versions/);
  });

  it('round-trips state and keeps the previous copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crt-watch-'));
    const store = new WatchStore(dir);
    const s = newWatchState(NOW);
    store.save(s);
    s.lastCycleAtUtc = 'x';
    store.save(s);
    expect(store.load(NOW)).toMatchObject({ specHash: SPEC_HASH, lastCycleAtUtc: 'x', orderExecution: 'NONE' });
    expect(JSON.parse(readFileSync(`${store.statePath}.previous`, 'utf8')).lastCycleAtUtc).toBeNull();
  });

  it('a fresh lock blocks a concurrent cycle; a stale lock is taken over', () => {
    const store = new WatchStore(mkdtempSync(join(tmpdir(), 'crt-watch-')));
    store.acquireLock(NOW);
    expect(() => store.acquireLock(NOW + 60_000)).toThrow(/holds/);
    expect(() => store.acquireLock(NOW + 16 * 60_000)).not.toThrow();
    store.releaseLock();
  });

  it('volume starts at 0.01 lot and only changes with an audited, attributed user action', () => {
    const s = newWatchState(NOW);
    expect(s.volumeLots).toBe(0.01);
    expect(() => setVolume(s, 0.02, '', NOW)).toThrow();
    expect(s.volumeLots).toBe(0.01);
    setVolume(s, 0.02, 'user@example', NOW);
    expect(s.volumeAudit).toEqual([{ atUtc: new Date(NOW).toISOString(), fromLots: 0.01, toLots: 0.02, changedBy: 'user@example' }]);
  });
});
