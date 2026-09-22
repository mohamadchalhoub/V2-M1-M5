/**
 * Warming the RSI engines from closed historical bars -- at first start, and
 * again whenever a resumed state turns out not to be warm.
 *
 * ## Why resuming needed this
 *
 * The observation loop originally warmed from history only when there was NO
 * saved state. On the VPS the very first start happened before the collector
 * had finished downloading M5 history, so M5 warmed from almost nothing and
 * saved that. Every later restart then resumed the under-warmed state rather
 * than re-reading history -- and the database meanwhile held 100,110 M5
 * candles that nothing used.
 *
 * Measured: M5 at 94 of the 256 closed bars it needs, so it produced no RSI at
 * all and could never trade, while M1 (464 bars) was fine. Left alone, M5
 * would have needed about thirteen more hours of live bars.
 *
 * ## Why re-warming is safe
 *
 * - Warm-up commits bars to the RSI state and never enters the code path that
 *   forms signals, so it cannot produce an entry (§3.3).
 * - The re-warmed timeframe starts with a FRESH crossing state, so nothing is
 *   armed by the replacement: a crossing still has to be observed live.
 * - The post-loss directional locks live in the database, not in this state,
 *   so re-warming cannot clear one.
 * - A warm timeframe is never touched, and a cold one is replaced only when
 *   history actually offers more closed bars than it already has.
 */
import type { PrismaClient } from '@prisma/client';
import { createEngineState, warmUpFromClosedBars, type EngineState } from './engine';
import { isWarmedUp } from './rsi';
import { SPEC, TIMEFRAMES, type Timeframe } from './spec';
import type { WatchState } from './state-store';

/** Closed bars required before a timeframe may emit a signal: period + seed + warm-up. */
export const WARMUP_BARS_NEEDED = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;

/**
 * A fresh engine for one timeframe, warmed from the newest closed bars in the
 * database. Ordering is by `openTime`, which is stored as broker wall clock;
 * a uniform offset does not change the order, and only the closes are used.
 */
export async function warmTimeframeFromHistory(
  prisma: PrismaClient,
  timeframe: Timeframe,
): Promise<{ engine: EngineState; bars: number }> {
  const rows = await prisma.historicalCandle.findMany({
    where: { symbol: SPEC.symbol, timeframe },
    orderBy: { openTime: 'desc' },
    take: WARMUP_BARS_NEEDED,
    select: { close: true },
  });
  const closes = rows.reverse().map((r) => Number(r.close));
  return { engine: warmUpFromClosedBars(createEngineState(timeframe), closes), bars: closes.length };
}

export interface RewarmedTimeframe {
  readonly timeframe: Timeframe;
  readonly fromBars: number;
  readonly toBars: number;
}

/** Re-warms every timeframe that is not warm, where history can do better. */
export async function rewarmColdTimeframes(
  prisma: PrismaClient,
  state: WatchState,
): Promise<{ state: WatchState; rewarmed: readonly RewarmedTimeframe[] }> {
  const engines = { ...state.engines };
  const crossings = { ...state.crossings };
  const rewarmed: RewarmedTimeframe[] = [];

  for (const timeframe of TIMEFRAMES) {
    const current = engines[timeframe];
    if (isWarmedUp(current.rsi)) continue;

    const { engine, bars } = await warmTimeframeFromHistory(prisma, timeframe);
    // Never trade a longer live count for a shorter history one.
    if (bars <= current.rsi.closedBarCount) continue;

    engines[timeframe] = engine;
    // Kept in step with the engine's own: a fresh crossing, so the
    // replacement can arm nothing.
    crossings[timeframe] = engine.crossing;
    rewarmed.push({ timeframe, fromBars: current.rsi.closedBarCount, toBars: bars });
  }

  return { state: rewarmed.length > 0 ? { ...state, engines, crossings } : state, rewarmed };
}
