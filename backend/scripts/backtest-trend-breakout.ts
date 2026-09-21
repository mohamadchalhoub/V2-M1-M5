/**
 * §13 — backtest for the new h4-trend-h1-breakout-v1 strategy. Reuses the
 * SAME pure `evaluateTrendBreakoutSignal`/`computeRoundedSlTp` functions the
 * live coordinator calls (`trend-breakout-coordinator.service.ts`) via
 * `runTrendBreakoutInstrumentBacktest` (backend/src/trend-breakout/backtest.ts)
 * — never a second, independently-written scan of the same rule.
 *
 * Parameters used below (EMA50/200, ATR14 Wilder, 20-bar breakout, 1.5x/3x
 * ATR SL/TP, contract size, assumed spread) were NOT tuned against this
 * data — every threshold comes directly from the approved specification;
 * this run is reported once, as specified, per §13's "do not optimize
 * parameters during this task."
 *
 * Data-provenance disclosure (§13's "disclose previously inspected
 * periods"): before writing this script, this session ran ONLY
 * `count(*)`/`min(open_time)`/`max(open_time)` queries grouped by
 * symbol/timeframe against this database — never inspected any actual
 * price series, and never looked at how the strategy would have performed
 * before choosing any parameter (there were no parameters left to choose;
 * every one is specified). The full run below is therefore the first and
 * only time this exact rule set has been evaluated against this data.
 *
 * Run: npm run backtest-trend-breakout
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { HistoricalCandleService } from '../src/market-data/historical-candle.service';
import { runTrendBreakoutInstrumentBacktest, TrendBreakoutBacktestConfig, TrendBreakoutBacktestResult } from '../src/trend-breakout/backtest';

const EURUSD_CONTRACT_SIZE = 100_000; // standard forex lot — industry-standard, not broker-verified for THIS account (no SymbolMetadata row exists yet, see the delivery report)
const EURUSD_POINT_SIZE = 0.00001;
const ASSUMED_SPREAD_POINTS = 15; // same documented placeholder the legacy backtest script already uses for EURUSD
const EURUSD_VOLUME_LOTS = 0.12; // §2's stated initial EURUSD volume

function fmt(n: number | null, digits = 2): string {
  return n === null ? 'n/a' : n.toFixed(digits);
}

function report(label: string, result: TrendBreakoutBacktestResult): void {
  console.log(`\n=== ${label} ===`);
  console.log(`Total signals filled: ${result.totalTrades} (closed: ${result.wins + result.losses}, still open at end of data: ${result.openAtEnd})`);
  console.log(`Wins: ${result.wins}  Losses: ${result.losses}  Win rate: ${fmt(result.winRate !== null ? result.winRate * 100 : null)}%`);
  console.log(`Profit factor: ${result.profitFactorMoney === Infinity ? 'infinite (no losses)' : fmt(result.profitFactorMoney)}`);
  console.log(`Total P&L: $${fmt(result.totalPnlMoney)}  Max drawdown: $${fmt(result.maxDrawdownMoney)}`);
  console.log(`Avg holding duration: ${fmt(result.avgHoldingHours)} hours`);
  console.log(`Gate rejection counts (signal-engine gates): ${JSON.stringify(result.gateRejectionCounts)}`);
  console.log(`Gap/chase-filter rejections at the (approximated) next-open fill: ${result.gapChaseRejections}`);
  console.log(`Schedule (Beirut window) rejections at the (approximated) next-open fill: ${result.scheduleRejections}`);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const candleService = new HistoricalCandleService(prisma as any);

    const [h4Count, h1Count] = await Promise.all([
      prisma.historicalCandle.count({ where: { symbol: 'EURUSD', timeframe: 'H4' } }),
      prisma.historicalCandle.count({ where: { symbol: 'EURUSD', timeframe: 'H1' } }),
    ]);
    console.log(`EURUSD H4 candles available: ${h4Count}. EURUSD H1 candles available: ${h1Count}.`);

    const goldH1Count = await prisma.historicalCandle.count({ where: { symbol: 'XAUUSD', timeframe: 'H1' } });
    console.log(`\nXAUUSD (gold) H1 candles available: ${goldH1Count}.`);
    if (goldH1Count === 0) {
      console.log(
        'GOLD BACKTEST: DATA UNAVAILABLE. This database has never collected XAUUSD candle history (CANDLE_SYMBOLS ' +
          'was never configured to include it, and this session had no live MT5 terminal connection to backfill it). ' +
          'The gold side of the strategy is fully implemented and unit-tested (signal engine, SL/TP, risk gates all ' +
          'run symbol-agnostically — see test/trend-breakout/), but there is no historical P&L result to report for ' +
          'it, and none is fabricated here. Combined (EURUSD+gold, shared account) backtesting is correspondingly ' +
          'also not run against real data for the same reason — runCombinedTrendBreakoutBacktest exists and is ' +
          'unit-tested against synthetic two-instrument data (test/trend-breakout/backtest.spec.ts) but has no real ' +
          'gold series to combine with EURUSD here.',
      );
    }

    const from = new Date('2000-01-01T00:00:00Z');
    const to = new Date();
    const [h4Candles, h1Candles] = await Promise.all([
      candleService.getCandlesInRange('EURUSD', 'H4', from, to),
      candleService.getCandlesInRange('EURUSD', 'H1', from, to),
    ]);
    console.log(`\nEURUSD H4 range: ${h4Candles[0]?.openTime.toISOString()} .. ${h4Candles.at(-1)?.openTime.toISOString()} (${h4Candles.length} candles)`);
    console.log(`EURUSD H1 range: ${h1Candles[0]?.openTime.toISOString()} .. ${h1Candles.at(-1)?.openTime.toISOString()} (${h1Candles.length} candles)`);

    const config: TrendBreakoutBacktestConfig = {
      volumeLots: EURUSD_VOLUME_LOTS,
      contractSize: EURUSD_CONTRACT_SIZE,
      spreadPrice: ASSUMED_SPREAD_POINTS * EURUSD_POINT_SIZE,
      priceIncrement: EURUSD_POINT_SIZE,
    };
    console.log(`\nConfig: ${JSON.stringify(config)} (contract size and spread are documented assumptions — no SymbolMetadata/live-spread data exists yet for this account, see the delivery report's "remaining prerequisites").`);

    const result = runTrendBreakoutInstrumentBacktest('EURUSD', h4Candles, h1Candles, config);
    report('EURUSD — h4-trend-h1-breakout-v1, full available history', result);

    console.log(
      '\nHonest caveats (do not skip these when reading the numbers above):\n' +
        '- Bar-only approximation (§13\'s own allowance): entries fill at the next H1 candle\'s open, not\n' +
        '  a genuine sub-minute quote — this database has no historical tick/bid-ask archive. The real\n' +
        "  §8 60-second expiry rule is therefore NOT modeled here (it cannot be, against hourly bars — see\n" +
        "  backtest.ts's own module comment); the gap/chase price filter IS modeled and does reject fills\n" +
        `  that drifted too far (${result.gapChaseRejections} such rejection(s) this run).\n` +
        '- Contract size (100,000, the standard forex lot) and the 15-point assumed spread are documented\n' +
        "  placeholders, not this account's own broker-verified values — no SymbolMetadata row exists yet\n" +
        '  (no live MT5 terminal was connected in this session; see the delivery report).\n' +
        '- No commission or swap is modeled (no historical cost data available for this account/symbol\n' +
        '  combination in this database).\n' +
        '- No account-level risk gates (per-trade/combined/daily-loss/drawdown) are applied in this SOLO\n' +
        '  run — those require a starting account equity, which this database has none of (zero\n' +
        '  AccountSnapshot rows for the dedicated demo account) — see runCombinedTrendBreakoutBacktest\'s\n' +
        '  own doc comment for where that logic lives and is unit-tested instead.\n' +
        '- This is a walk-through over the strategy\'s full specified rules exactly as given, with every\n' +
        '  parameter fixed in advance — there was no parameter search, so no in-sample/out-of-sample split\n' +
        '  applies here the way it would to a tuned strategy; it is still only ONE historical sample,\n' +
        '  not a claim about future performance.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
