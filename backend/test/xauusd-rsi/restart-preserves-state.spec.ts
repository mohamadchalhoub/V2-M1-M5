/**
 * An ordinary restart must PRESERVE a valid indicator, and rebuild only when
 * the state is genuinely invalid or incompatible.
 *
 * Both directions matter, and both have bitten this system:
 *
 *   - Rebuilding too eagerly throws away warm-up. The indicator needs 256
 *     contiguous closed M1 bars, so a needless rebuild blinds the strategy
 *     for hours — and after a weekend there may not be 256 bars available
 *     at all until the session has run long enough.
 *   - Preserving too eagerly keeps a broken clock. A persisted engine whose
 *     `lastObservationT` sat three hours ahead rejected every incoming tick
 *     as out-of-order and froze RSI, while cadence, tick counts and recovery
 *     all still reported healthy.
 *
 * These tests pin the boundary between the two.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RsiWatchStore, createWatchState, SpecHashMismatchError } from '../../src/xauusd-rsi/state-store';
import { applyClosedBar, createEngineState, engineWarmedUp, M1_MS } from '../../src/xauusd-rsi/engine';
import { RSI_CURSOR_TIME_BASIS } from '../../src/xauusd-rsi/tick-time';
import { RSI_ENGINE_CLOCK_FUTURE_LIMIT_MS } from '../../src/xauusd-rsi/safety-constants';
import { SPEC, SPEC_HASH } from '../../src/xauusd-rsi/spec';

const REQUIRED_BARS = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
const NOW = Date.UTC(2026, 8, 21, 6, 0, 0);

/** A genuinely warmed-up engine whose last bar closed just before `endT`. */
function warmedEngine(endT: number) {
  let e = createEngineState('TICK');
  let t = endT - REQUIRED_BARS * M1_MS;
  for (let i = 0; i < REQUIRED_BARS; i += 1) {
    e = applyClosedBar(e, t, 4300 + Math.sin(i / 7) * 3).state;
    t += M1_MS;
  }
  return e;
}

describe('RsiWatchStore.load — what survives a restart', () => {
  let dir: string;
  let store: RsiWatchStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsi-restart-'));
    store = new RsiWatchStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts fresh only when there is genuinely no state file', () => {
    const state = store.load(SPEC.strategyVersion, 'TICK');
    expect(state.engine.closedBarsApplied).toBe(0);
    expect(engineWarmedUp(state.engine)).toBe(false);
    expect(state.cursor.timeBasis).toBe(RSI_CURSOR_TIME_BASIS);
  });

  it('PRESERVES a warmed indicator across a save/load cycle — warm-up is not redone', () => {
    const saved = { ...createWatchState(SPEC.strategyVersion, 'TICK'), engine: warmedEngine(NOW) };
    expect(engineWarmedUp(saved.engine)).toBe(true);
    store.save(saved);

    const loaded = store.load(SPEC.strategyVersion, 'TICK');

    expect(engineWarmedUp(loaded.engine)).toBe(true);
    expect(loaded.engine.closedBarsApplied).toBe(REQUIRED_BARS);
    expect(loaded.engine.lastClosedBarT).toBe(saved.engine.lastClosedBarT);
    expect(loaded.engine.lastObservationT).toBe(saved.engine.lastObservationT);
    // The recursive average itself, to full precision.
    expect(loaded.engine.rsi.avgGain).toBe(saved.engine.rsi.avgGain);
    expect(loaded.engine.rsi.avgLoss).toBe(saved.engine.rsi.avgLoss);
  });

  it('preserves the observation cursor, so a restart does not re-read history', () => {
    const saved = {
      ...createWatchState(SPEC.strategyVersion, 'TICK'),
      engine: warmedEngine(NOW),
      cursor: { lastTimestampMs: NOW, lastTickKey: 'k', lastTimestampKeys: ['k'], timeBasis: RSI_CURSOR_TIME_BASIS },
    };
    store.save(saved);

    const loaded = store.load(SPEC.strategyVersion, 'TICK');
    expect(loaded.cursor.lastTimestampMs).toBe(NOW);
    expect(loaded.cursor.timeBasis).toBe(RSI_CURSOR_TIME_BASIS);
  });

  it('re-arms recovery on every restart, without touching the indicator', () => {
    const saved = {
      ...createWatchState(SPEC.strategyVersion, 'TICK'),
      engine: warmedEngine(NOW),
      recovery: {
        lastCycleAtUtc: '2026-09-21T05:00:00.000Z', lastReseedAtUtc: null,
        recoveryComplete: true, lastRecoveryDetail: 'done', restartCount: 4,
        cadenceSamplesMs: [1001, 1002, 1003],
      },
    };
    store.save(saved);

    const loaded = store.load(SPEC.strategyVersion, 'TICK');

    // Continuity must be re-established against real broker state...
    expect(loaded.recovery.recoveryComplete).toBe(false);
    expect(loaded.recovery.restartCount).toBe(5);
    // ...and cadence from a process that is no longer running is discarded.
    expect(loaded.recovery.cadenceSamplesMs).toEqual([]);
    // ...but none of that costs the indicator its warm-up.
    expect(engineWarmedUp(loaded.engine)).toBe(true);
  });

  it('REFUSES to load state belonging to a different spec, rather than mixing rule versions', () => {
    const saved = { ...createWatchState(SPEC.strategyVersion, 'TICK'), engine: warmedEngine(NOW), specHash: 'deadbeefdeadbeef' };
    store.save(saved);

    expect(() => store.load(SPEC.strategyVersion, 'TICK')).toThrow(SpecHashMismatchError);
  });

  it('REFUSES to silently cold-start from an unreadable state file', () => {
    writeFileSync(join(dir, 'xauusd-rsi-watch-state.json'), '{ this is not json');
    // A cold start here would be indistinguishable from a genuine first run,
    // which is exactly the confusion that must not happen silently.
    expect(() => store.load(SPEC.strategyVersion, 'TICK')).toThrow(/unreadable/);
  });

  it('keeps the previous state file, so a bad save is recoverable', () => {
    const first = { ...createWatchState(SPEC.strategyVersion, 'TICK'), engine: warmedEngine(NOW) };
    store.save(first);
    const second = { ...first, engine: warmedEngine(NOW + M1_MS) };
    store.save(second);

    const previous = JSON.parse(readFileSync(join(dir, 'xauusd-rsi-watch-state.json.previous'), 'utf8')) as typeof first;
    expect(previous.engine.lastClosedBarT).toBe(first.engine.lastClosedBarT);
  });
});

describe('The rebuild boundary', () => {
  /**
   * The watch cycle rebuilds on exactly two conditions. Asserting them as
   * predicates keeps the boundary explicit and independent of how the cycle
   * happens to be wired.
   */
  function wouldRebuild(engineClockT: number, nowT: number, timeBasis: string | undefined, cursorSet: boolean) {
    const ahead = engineClockT - nowT;
    const basisStale = timeBasis !== RSI_CURSOR_TIME_BASIS;
    return ahead > RSI_ENGINE_CLOCK_FUTURE_LIMIT_MS || (basisStale && cursorSet);
  }

  it('does NOT rebuild an ordinary, correctly-timestamped engine', () => {
    // A healthy engine's clock is at or slightly behind wall clock.
    expect(wouldRebuild(NOW - 1_000, NOW, RSI_CURSOR_TIME_BASIS, true)).toBe(false);
    expect(wouldRebuild(NOW, NOW, RSI_CURSOR_TIME_BASIS, true)).toBe(false);
  });

  it('tolerates ordinary clock skew rather than rebuilding on it', () => {
    expect(wouldRebuild(NOW + RSI_ENGINE_CLOCK_FUTURE_LIMIT_MS - 1_000, NOW, RSI_CURSOR_TIME_BASIS, true)).toBe(false);
  });

  it('DOES rebuild a clock meaningfully in the future', () => {
    expect(wouldRebuild(NOW + RSI_ENGINE_CLOCK_FUTURE_LIMIT_MS + 1_000, NOW, RSI_CURSOR_TIME_BASIS, true)).toBe(true);
    // The real case: three hours ahead, on the broker's wall clock.
    expect(wouldRebuild(NOW + 3 * 60 * 60 * 1000, NOW, RSI_CURSOR_TIME_BASIS, true)).toBe(true);
  });

  it('DOES rebuild a cursor recorded on an older time basis', () => {
    expect(wouldRebuild(NOW - 1_000, NOW, undefined, true)).toBe(true);
    expect(wouldRebuild(NOW - 1_000, NOW, 'SOME_OLDER_BASIS', true)).toBe(true);
  });

  it('does not rebuild on a stale basis when there is no cursor to be wrong', () => {
    // A fresh, never-used cursor carries nothing that can be on the wrong
    // timeline, so there is nothing to discard.
    expect(wouldRebuild(0, NOW, undefined, false)).toBe(false);
  });

  it('never rebuilds for an engine that is merely BEHIND, however far', () => {
    // Being behind is normal after a pause: those observations are simply
    // old, and the ordinary staleness rules handle them.
    expect(wouldRebuild(NOW - 48 * 60 * 60 * 1000, NOW, RSI_CURSOR_TIME_BASIS, true)).toBe(false);
  });
});

describe('Spec hash guards rule compatibility', () => {
  it('is the frozen rules hash the persisted state is compared against', () => {
    expect(SPEC_HASH).toBe('f189d2bb39ab8a5d');
    expect(createWatchState(SPEC.strategyVersion, 'TICK').specHash).toBe(SPEC_HASH);
  });
});
