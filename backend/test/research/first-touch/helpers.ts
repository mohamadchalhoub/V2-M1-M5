// Small synthetic-fixture builders shared by this directory's spec files.
// Every timestamp taken/returned by these helpers is UTC, matching the
// engine's own convention.
import type { Candle, Tick } from '../../../src/research/first-touch/types';

/** A one-off OHLC candle. `durationMs` defaults to 1 minute (M1, what the study's touch/outcome resolution uses) — pass a larger value for H4 level-construction fixtures. */
export function candle(openTimeIso: string, open: number, high: number, low: number, close: number, durationMs = 60_000): Candle {
  const openTime = new Date(openTimeIso);
  return { openTime, closeTime: new Date(openTime.getTime() + durationMs), open, high, low, close };
}

/** An H4 (4-hour) candle — sugar for level-construction fixtures. */
export function h4Candle(openTimeIso: string, open: number, high: number, low: number, close: number): Candle {
  return candle(openTimeIso, open, high, low, close, 4 * 60 * 60 * 1000);
}

export function tick(timestampIso: string, bid: number, ask: number): Tick {
  return { timestamp: new Date(timestampIso), bid, ask };
}
