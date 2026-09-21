// Covers required scenarios 5, 6, 7, 8, 10, 11, 12.
import { describe, expect, it } from 'vitest';
import { buildTouchEvent, createLevel, findFirstTouch, resolveOutcome, resolvePriceRace } from '../../../src/research/first-touch/engine';
import type { DataGap } from '../../../src/research/first-touch/types';
import { candle, h4Candle, tick } from './helpers';

const SYMBOL = 'XAUUSD';
const ENTRY_TIME = new Date('2026-01-02T00:00:00.000Z');

describe('scenario 5 — ordinary TP-first vs SL-first resolution', () => {
  it('resolves WIN when TP is hit first', () => {
    const c1 = candle('2026-01-02T00:01:00.000Z', 2001, 2010, 1999, 2009); // high reaches tp=2010, low never reaches sl=1990
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [c1], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('WIN');
    expect(result.resolutionPrice).toBe(2010);
    expect(result.resolvedAtUtc?.toISOString()).toBe(c1.openTime.toISOString());
  });

  it('resolves LOSS when SL is hit first', () => {
    const c1 = candle('2026-01-02T00:01:00.000Z', 1999, 2001, 1990, 1991); // low reaches sl=1990, high never reaches tp=2010
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [c1], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('LOSS');
    expect(result.resolutionPrice).toBe(1990);
  });

  it('the same $10 rule mirrors correctly for a SELL (resistance) entry', () => {
    const c1 = candle('2026-01-02T00:01:00.000Z', 2000, 2001, 1990, 1991); // low reaches SELL's tp = entry-10 = 1990
    const result = resolvePriceRace({
      direction: 'SELL', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [c1], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.tp).toBe(1990);
    expect(result.sl).toBe(2010);
    expect(result.status).toBe('WIN');
  });
});

describe('scenario 6 — resolution after a significant delay, no forced cutoff at noon or any other time', () => {
  it('resolves WIN days later, after idling through several Beirut noons', () => {
    const idle1 = candle('2026-01-02T10:00:00.000Z', 2000, 2003, 1997, 2001); // 12:00 Beirut local (winter) — must NOT force a close
    const idle2 = candle('2026-01-03T10:00:00.000Z', 2001, 2004, 1996, 2002);
    const idle3 = candle('2026-01-04T10:00:00.000Z', 2002, 2004, 1995, 2000);
    const finallyHits = candle('2026-01-06T09:00:00.000Z', 2005, 2010, 2004, 2009); // 5 days after entry

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [idle1, idle2, idle3, finallyHits], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(result.status).toBe('WIN');
    expect(result.resolvedAtUtc?.toISOString()).toBe(finallyHits.openTime.toISOString());
    // ~4 days of holding, proving nothing forced an earlier exit.
    expect(result.holdingDurationMs).toBeGreaterThan(4 * 24 * 60 * 60 * 1000);
  });
});

describe('scenario 7 — an UNRESOLVED event is correctly carried forward and re-evaluated with more data / a later frozen end', () => {
  it('is UNRESOLVED against an early frozen end, then WIN once more data and a later frozen end are supplied', () => {
    const idle = candle('2026-01-02T01:00:00.000Z', 2000, 2003, 1997, 2001);
    const laterHit = candle('2026-01-10T00:00:00.000Z', 2005, 2010, 2004, 2009);

    const early = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [idle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'), // before laterHit even exists
    });
    expect(early.status).toBe('UNRESOLVED');
    expect(early.resolvedAtUtc).toBeNull();

    // Re-evaluate the SAME event, now with more data and a later frozen end — a pure re-computation, nothing "carried" statefully.
    const later = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [idle, laterHit], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-11T00:00:00.000Z'),
    });
    expect(later.status).toBe('WIN');
    expect(later.resolvedAtUtc?.toISOString()).toBe(laterHit.openTime.toISOString());
  });
});

describe('scenario 8 — same-M1-candle race is AMBIGUOUS without ticks, resolved correctly with ticks', () => {
  const raceCandle = candle('2026-01-02T00:01:00.000Z', 2000, 2011, 1989, 2000); // high >= tp(2010) AND low <= sl(1990) in the same candle

  it('is AMBIGUOUS when no tick data covers the race candle', () => {
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [raceCandle], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.raceCandleUtc?.toISOString()).toBe(raceCandle.openTime.toISOString());
    expect(result.resolvedAtUtc).toBeNull();
  });

  it('resolves correctly (SL first) when tick data covering the race candle is supplied', () => {
    const ticks = [
      tick('2026-01-02T00:01:10.000Z', 1995, 1996), // still between tp/sl
      tick('2026-01-02T00:01:20.000Z', 1990, 1991), // SL (1990) reached first
      tick('2026-01-02T00:01:40.000Z', 2010, 2011), // TP would be reached later — must not win
    ];
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [raceCandle], ticks, gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('LOSS');
    expect(result.resolutionPrice).toBe(1990);
    expect(result.resolvedAtUtc?.toISOString()).toBe('2026-01-02T00:01:20.000Z');
  });

  it('resolves correctly (TP first) when ticks show the opposite order', () => {
    const ticks = [
      tick('2026-01-02T00:01:10.000Z', 2005, 2006),
      tick('2026-01-02T00:01:20.000Z', 2010, 2011), // TP reached first
      tick('2026-01-02T00:01:40.000Z', 1990, 1991),
    ];
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [raceCandle], ticks, gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('WIN');
    expect(result.resolutionPrice).toBe(2010);
  });
});

describe('scenario 10 — a post-entry data gap forces INDETERMINATE, even when the first visible price after the gap is already beyond TP', () => {
  it('never takes the forbidden shortcut of inferring a WIN just because price is beyond TP right after the gap (UNCONFIRMED gap)', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001); // ordinary, resolves nothing
    const gap: DataGap = { symbol: SYMBOL, start: clean.closeTime, end: new Date('2026-01-02T06:00:00.000Z'), kind: 'UNCONFIRMED' };
    // First visible candle after the gap: already beyond TP (2010) on its low, let alone its high.
    // The forbidden shortcut would read this as an obvious WIN — the correct answer is INDETERMINATE,
    // because the untracked path through the gap could just as easily have crossed SL (1990) first.
    const afterGap = candle('2026-01-02T06:00:00.000Z', 2015, 2020, 2011, 2018);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, afterGap], ticks: [], gaps: [gap], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('INDETERMINATE');
    expect(result.status).not.toBe('WIN');
    expect(result.concealingGap).toEqual(gap);
    expect(result.resolvedAtUtc).toBeNull();
  });

  it('resolves normally through the same gap when tick data actually covers it', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    const gap: DataGap = { symbol: SYMBOL, start: clean.closeTime, end: new Date('2026-01-02T06:00:00.000Z'), kind: 'UNCONFIRMED' };
    const afterGap = candle('2026-01-02T06:00:00.000Z', 2015, 2020, 2011, 2018);
    const ticksThroughGap = [
      tick('2026-01-02T02:00:00.000Z', 1995, 1996),
      tick('2026-01-02T04:00:00.000Z', 2010, 2011), // TP reached inside the gap, confirmed by ticks
    ];

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, afterGap], ticks: ticksThroughGap, gaps: [gap], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('WIN');
    expect(result.resolvedAtUtc?.toISOString()).toBe('2026-01-02T04:00:00.000Z');
  });

  it('resolves normally off the reopen candle\'s own wicks across a CONFIRMED_CLOSURE, with no tick requirement', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    // A verified-shut weekend/holiday closure — no trading happened inside it by definition, so there is
    // no hidden path to worry about, only the single discrete jump from `clean`'s close to `reopen`'s open.
    const closure: DataGap = { symbol: SYMBOL, start: clean.closeTime, end: new Date('2026-01-02T06:00:00.000Z'), kind: 'CONFIRMED_CLOSURE' };
    // Reopens beyond TP (2010) on its low — since the closure is CONFIRMED, this is resolved directly off
    // this candle's own wicks (a real, single reopen-gap jump), never treated as INDETERMINATE.
    const reopen = candle('2026-01-02T06:00:00.000Z', 2015, 2020, 2011, 2018);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, reopen], ticks: [], gaps: [closure], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('WIN');
    expect(result.resolvedAtUtc?.toISOString()).toBe(reopen.openTime.toISOString());
    expect(result.resolutionPrice).toBe(2010); // TP price, not the reopen print — the fill model is a stop/limit order, filled at its own price
  });

  it('still marks the reopen AMBIGUOUS (never guesses) when the single reopen jump itself straddles both TP and SL', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    const closure: DataGap = { symbol: SYMBOL, start: clean.closeTime, end: new Date('2026-01-02T06:00:00.000Z'), kind: 'CONFIRMED_CLOSURE' };
    // Reopens with a huge range spanning BOTH TP (2010) and SL (1990) inside one candle — the closure being
    // confirmed tells us nothing traded during it, but says nothing about which boundary this one visible
    // reopen candle reached first, so this must still be AMBIGUOUS, not resolved by guessing.
    const reopen = candle('2026-01-02T06:00:00.000Z', 2000, 2015, 1985, 2005);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, reopen], ticks: [], gaps: [closure], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('AMBIGUOUS');
    expect(result.raceCandleUtc?.toISOString()).toBe(reopen.openTime.toISOString());
  });
});

describe('scenario 12 — a candle whose OPEN alone already lies beyond a boundary resolves immediately, never ambiguous just because its later range also reaches the opposite boundary', () => {
  it('resolves WIN off the open when the open already prints beyond TP, even though the same candle later dips beyond SL too', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    // Opens at 2012 (already >= TP=2010) then swings all the way down to 1985 (beyond SL=1990) later in
    // the SAME candle. The open already tells us TP was reached first — the later dip must not flip this
    // to AMBIGUOUS, because a real order would already have been filled at the open-side gap.
    const raceCandle = candle('2026-01-02T00:02:00.000Z', 2012, 2018, 1985, 1990);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, raceCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('WIN');
    expect(result.resolvedAtUtc?.toISOString()).toBe(raceCandle.openTime.toISOString());
    expect(result.resolutionPrice).toBe(2010); // idealized (default): the nominal TP, not the gap print
  });

  it('resolves LOSS off the open, symmetric case (open already beyond SL, later range also reaches TP)', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    const raceCandle = candle('2026-01-02T00:02:00.000Z', 1988, 2015, 1980, 2005);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, raceCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('LOSS');
    expect(result.resolutionPrice).toBe(1990); // idealized: the nominal SL
  });

  it('uses the real open print, not the nominal level, when realisticGapFills is set (the executable path)', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    const raceCandle = candle('2026-01-02T00:02:00.000Z', 2012, 2018, 1985, 1990);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, raceCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
      realisticGapFills: true,
    });

    expect(result.status).toBe('WIN');
    expect(result.resolutionPrice).toBe(2012); // the real print it gapped to, never a price that never traded
  });

  it('still resolves AMBIGUOUS when the open itself is neutral but the range straddles both boundaries — the fix only short-circuits a DECISIVE open', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    // Open (2000) is neutral — beyond neither TP (2010) nor SL (1990) — so no shortcut applies here.
    const raceCandle = candle('2026-01-02T00:02:00.000Z', 2000, 2015, 1985, 2005);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, raceCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('AMBIGUOUS');
  });
});

describe('scenario 11 — a gap-through entry produces DIFFERENT idealized vs executable results', () => {
  it('keeps the idealized (entry-at-level) and executable (entry-at-reachable-price) paths structurally separate and numerically different', () => {
    const source = h4Candle('2026-01-01T00:00:00.000Z', 2005, 2015, 1995, 2010);
    const level = createLevel({
      id: 'gap-through-lvl',
      role: 'SUPPORT',
      zone: { lower: 1999, upper: 2001 },
      sourceCandles: [source],
      establishedAt: source.closeTime,
      methodVersion: 'v1',
    });

    // Approach from above: this candle's close (2010) is above zone.upper (2001).
    const previous = candle('2026-01-02T03:00:00.000Z', 2012, 2015, 2008, 2010);
    // The touch candle GAPS THROUGH on its open (1995 < zone.lower=1999) but its
    // body closes back inside the zone (2000), so it still registers as a touch.
    // 03:01 UTC = 05:01 Beirut local (winter) — inside the eligible window.
    const touchCandle = candle('2026-01-02T03:01:00.000Z', 1995, 2001, 1993, 2000);

    const candles = [source, previous, touchCandle];
    const detection = findFirstTouch({ level, candles, gaps: [], symbol: SYMBOL });
    expect(detection.status).toBe('TOUCHED');

    const touchEvent = buildTouchEvent({ level, detection, candles, symbol: SYMBOL });
    expect(touchEvent).not.toBeNull();
    expect(touchEvent!.gappedThrough).toBe(true);
    expect(touchEvent!.idealEntryPrice).toBe(2000); // zone midpoint
    expect(touchEvent!.executableEntryPrice).toBe(1995); // the actual open print
    expect(touchEvent!.entryDirection).toBe('BUY'); // SUPPORT + FROM_ABOVE

    // Ideal: entry 2000 -> tp 2010 / sl 1990. Executable: entry 1995 -> tp 2005 / sl 1985.
    const afterA = candle('2026-01-02T04:00:00.000Z', 2003, 2007, 1999, 2006); // hits executable's tp(2005), NOT ideal's tp(2010) or ideal's sl(1990)
    const afterB = candle('2026-01-02T05:00:00.000Z', 2000, 2005, 1988, 1990); // hits ideal's sl(1990); irrelevant to executable (already resolved)

    const outcome = resolveOutcome({
      touchEvent: touchEvent!,
      level,
      candles: [...candles, afterA, afterB],
      gaps: [],
      symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-02T06:00:00.000Z'),
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.idealized.status).toBe('LOSS');
    expect(outcome!.executable.status).toBe('WIN');
    expect(outcome!.idealized.entryPrice).not.toBe(outcome!.executable.entryPrice);
  });
});

describe('scenario 12 — re-processing identical input twice produces identical output (pure-function idempotence)', () => {
  it('resolvePriceRace is idempotent', () => {
    const c1 = candle('2026-01-02T00:01:00.000Z', 2001, 2010, 1999, 2009);
    const args = {
      direction: 'BUY' as const, entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [c1], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    };
    expect(resolvePriceRace({ ...args })).toEqual(resolvePriceRace({ ...args }));
  });

  it('the full resolveOutcome pipeline is idempotent', () => {
    const source = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'idem-lvl', role: 'SUPPORT', price: 2000, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });
    const previous = h4Candle('2026-01-01T04:00:00.000Z', 2010, 2015, 2008, 2012);
    const touchCandle = candle('2026-01-02T03:01:00.000Z', 2005, 2006, 1994, 1996);
    const after = candle('2026-01-02T04:00:00.000Z', 2001, 2010, 1999, 2005);
    const candles = [source, previous, touchCandle, after];
    const gaps: DataGap[] = [];
    const frozenEndUtc = new Date('2026-01-03T00:00:00.000Z');

    const run = () => {
      const detection = findFirstTouch({ level, candles, gaps, symbol: SYMBOL });
      const touchEvent = buildTouchEvent({ level, detection, candles, symbol: SYMBOL });
      return resolveOutcome({ touchEvent: touchEvent!, level, candles, gaps, symbol: SYMBOL, frozenEndUtc });
    };

    expect(run()).toEqual(run());
  });
});

describe('scenario 13 — the entry/touch candle is processed explicitly, not skipped', () => {
  // The hypothetical entry happens the instant price first reaches the
  // touch price, not at this candle's close — a TP or SL reached later in
  // the SAME minute must be accounted for, and OHLC alone cannot always
  // say whether it happened before or after entry.

  it('the docstring example: BUY touch 4340, TP 4350, SL 4330, entry candle O=4345 H=4352 L=4338 C=4342 — AMBIGUOUS even though SL is never reached at all', () => {
    // H (4352) clears TP, but O (4345) sits ABOVE the touch (4340), so price
    // could have spiked up to 4352 BEFORE ever coming down to touch (TP hit
    // pre-entry, doesn't count — the remaining path only reaches L=4338,
    // never re-crossing TP, so the race would still be open after this
    // candle) OR touched first and only THEN risen to 4352 (TP hit
    // post-entry — WIN). Both are equally consistent with this OHLC row.
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4345, 4352, 4338, 4342);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('AMBIGUOUS');
    expect(result.raceCandleUtc?.toISOString()).toBe(entryCandle.openTime.toISOString());
  });

  it('mirrored SELL case: touch 4340, TP 4330, SL 4350, entry candle O=4335 H=4342 L=4328 C=4338 — AMBIGUOUS, TP only reachable via a before/after-entry detour', () => {
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4335, 4342, 4328, 4338);

    const result = resolvePriceRace({
      direction: 'SELL', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('AMBIGUOUS');
  });

  it('counterexample to naive two-path sampling: BUY touch 4340, TP 4350, SL 4330, O=4345 H=4352 L=4328 C=4348 — both simplified extreme-order paths agree on LOSS, but a third, equally compatible path (4345 -> 4340 entry -> 4350 TP -> 4352 -> 4328 -> 4348) produces WIN, so this must be AMBIGUOUS', () => {
    // Sampling exactly two hypotheses (open->high->low->close and
    // open->low->high->close) is NOT proof every OHLC-compatible path
    // agrees — a path with an extra reversal (touch, then immediately up
    // through TP and on to the high, THEN down to the low, THEN up to the
    // close) is equally consistent with this exact OHLC row and produces
    // a different outcome. Both two-leg samples land on LOSS here (in
    // both, the touch is found on a leg heading toward the low, and SL
    // sits between the touch and the low), but WIN is reachable too (see
    // resolveOhlcCandle's own docstring for why: SL is always reachable
    // here since the low clears it, but TP is ALSO reachable via a path
    // that reaches the high immediately after the touch rather than
    // before it or only via the low-first leg) — so this must be
    // AMBIGUOUS, not silently resolved by whichever two paths happen to
    // get sampled.
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4345, 4352, 4328, 4348);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('AMBIGUOUS');
    expect(result.raceCandleUtc?.toISOString()).toBe(entryCandle.openTime.toISOString());
  });

  it('SELL counterpart of the two-path-sampling counterexample: touch 4340, TP 4330, SL 4350, O=4335 H=4352 L=4328 C=4332 — both simplified paths agree on LOSS, but a third path produces WIN', () => {
    // Exact mirror of the BUY counterexample above (favorable direction is
    // down for a SELL, so the roles of the real high/low swap accordingly).
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4335, 4352, 4328, 4332);

    const result = resolvePriceRace({
      direction: 'SELL', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('AMBIGUOUS');
  });

  it('a definite WIN established from OHLC despite the same before/after-entry detour shape: the close itself is already past TP, so both orderings agree', () => {
    // Same shape as the docstring example (O above touch, H clears TP) but
    // C (4351) is ALSO past TP — so even the "H was hit before entry"
    // reading still finds TP reached again on the way to this close. Both
    // hypotheses agree: this must resolve WIN, not be discarded as ambiguous.
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4341, 4355, 4335, 4351);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('WIN');
    expect(result.resolvedAtUtc?.toISOString()).toBe(entryCandle.openTime.toISOString());
    expect(result.resolutionPrice).toBe(4350);
  });

  it('a definite LOSS established from OHLC, mirrored: SL is reached immediately after entry in every ordering, before TP could ever be reached', () => {
    // O is above touch (natural approach), and the immediate post-entry
    // continuation toward L passes straight through SL (4330) before any
    // detour to H could matter — SL sits BETWEEN the touch and L in both
    // hypotheses, so it is always reached first regardless of order.
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4341, 4345, 4322, 4325);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('LOSS');
    expect(result.resolutionPrice).toBe(4330);
  });

  it('opening exactly at the touch price with both boundaries reachable is the classic same-candle race — still AMBIGUOUS, no pre-entry detour needed to explain it', () => {
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4340, 4355, 4320, 4340);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('AMBIGUOUS');
  });

  it('opening exactly at the touch price with only ONE boundary ever reachable resolves cleanly — no ambiguity when there is nothing to be ambiguous about', () => {
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4340, 4345, 4325, 4335); // never reaches TP=4350

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('LOSS');
  });

  it('neither boundary reached in the entry candle: falls through and lets a later candle resolve the race, rather than getting stuck', () => {
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4341, 4348, 4335, 4344); // established NONE either way
    const later = candle('2026-01-02T00:01:00.000Z', 4344, 4351, 4343, 4350); // clean WIN

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle, later], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('WIN');
    expect(result.resolvedAtUtc?.toISOString()).toBe(later.openTime.toISOString());
  });

  it('with a genuinely dense, verified tick sequence covering the entry candle, the actual sequence is used directly instead of the OHLC inference', () => {
    // Same OHLC shape as the docstring example (would be AMBIGUOUS on OHLC
    // alone), but a densely-spaced (well under the sufficiency gap
    // threshold) tick sequence shows SL was actually reached first.
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4345, 4352, 4338, 4342);
    const ticks = [
      tick('2026-01-02T00:00:02.000Z', 4340, 4340.2), // the touch
      tick('2026-01-02T00:00:04.000Z', 4335, 4335.2),
      tick('2026-01-02T00:00:06.000Z', 4330, 4330.2), // SL reached
    ];

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks, gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('LOSS');
    expect(result.resolvedAtUtc?.toISOString()).toBe('2026-01-02T00:00:06.000Z');
  });

  it('a SPARSE tick sample (gaps too large to trust) never overrides OHLC ambiguity, even if it happens to show a crossing', () => {
    // Same shape again, but this tick sample has a >5s gap between the
    // touch and the next print — exactly the kind of partial coverage
    // that must fall back to the OHLC inference (AMBIGUOUS here) rather
    // than be trusted at face value.
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4345, 4352, 4338, 4342);
    const ticks = [
      tick('2026-01-02T00:00:01.000Z', 4340, 4340.2), // the touch
      tick('2026-01-02T00:00:20.000Z', 4330, 4330.2), // 19s later — far past the sufficiency threshold
    ];

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks, gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('AMBIGUOUS');
  });

  it('dense ticks that genuinely cover the whole candle with NO crossing are trusted as verified-clean, overriding what would otherwise be OHLC AMBIGUOUS', () => {
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4345, 4352, 4338, 4342);
    // Continuous coverage (4s spacing, no gap anywhere near the 5s
    // threshold) from just after open to just before close, oscillating
    // near the touch but never actually reaching TP or SL.
    const ticks: ReturnType<typeof tick>[] = [];
    for (let sec = 4; sec <= 56; sec += 4) {
      const price = 4340 + (sec % 8 === 0 ? 2 : -1); // stays well inside (4330, 4350)
      ticks.push(tick(`2026-01-02T00:00:${String(sec).padStart(2, '0')}.000Z`, price, price + 0.2));
    }

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks, gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    // Verified-clean this candle, falls through — nothing left to race with here, so UNRESOLVED, not AMBIGUOUS.
    expect(result.status).toBe('UNRESOLVED');
  });

  it('ticks entirely outside the entry candle (an earlier or later window) never substitute for real entry-candle tick coverage — still falls back to the OHLC inference', () => {
    const entryCandle = candle('2026-01-02T00:00:00.000Z', 4345, 4352, 4338, 4342);
    const ticks = [
      tick('2026-01-01T23:59:00.000Z', 4360, 4360.2), // an entirely earlier minute, not this candle
      tick('2026-01-02T00:05:00.000Z', 4300, 4300.2), // an entirely later minute, not this candle
    ];

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 4340, entryTimeUtc: ENTRY_TIME,
      candles: [entryCandle], ticks, gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    // No ticks fall inside [entryCandle.openTime, entryCandle.closeTime), so
    // this must fall back to the OHLC inference (AMBIGUOUS for this same
    // shape as the docstring example), never borrow a tick from outside
    // this candle's own window.
    expect(result.status).toBe('AMBIGUOUS');
  });
});
