import { Injectable, NotFoundException } from '@nestjs/common';
import { CandleTimeframe } from '@prisma/client';
import { CandleData, HistoricalCandleService } from '../market-data/historical-candle.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeDuringTradeFeatures,
  computePostExitFeatures,
  computePreEntryFeatures,
  DuringTradeFeatures,
  PostExitFeatures,
  PreEntryFeatures,
} from './feature-extraction';

export interface RoundTripTrade {
  positionId: string;
  side: 'BUY' | 'SELL';
  volume: number;
  entryTime: Date;
  entryPrice: number;
  exitTime: Date;
  exitPrice: number;
  /** Gross P/L (the OUT deal's own `profit` field) — what a broker statement shows as the trade's raw result. Kept separate from `netProfit` for chart display, where showing the broker's own figure is what a trader recognizes. */
  profit: number;
  /**
   * Audit finding (reconciliation session): `profit` alone is GROSS —
   * it excludes commission and swap, both of which are real costs already
   * realized on this closed position. A trade that's a small gross winner
   * can be a net loser once swap is included (confirmed against this
   * account's own real EURUSD history: 3 positions have gross profit == 0
   * but net < 0 once swap is added). `HistoricalPatternSummaryService`
   * uses THIS field, not `profit`, to classify win/loss/breakeven — a
   * "win rate" fed to the AI should reflect what the trader actually kept,
   * not the pre-cost figure.
   */
  netProfit: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface TradeChartWindow {
  positionId: string;
  symbol: string;
  timeframe: CandleTimeframe;
  side: 'BUY' | 'SELL';
  entryMarker: { time: Date; price: number };
  exitMarker: { time: Date; price: number; profit: number };
  stopLoss: number | null;
  takeProfit: number | null;
  candles: CandleData[];
  features: {
    preEntry: PreEntryFeatures;
    duringTrade: DuringTradeFeatures;
    postExit: PostExitFeatures;
  };
  /** Non-null when the candle window MT5 could actually provide is narrower than the ideal context window — never fabricated, just reported (spec §15). */
  dataLimitation: string | null;
}

const CANDLE_DURATION_MS: Record<CandleTimeframe, number> = {
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  // M30/H4/D1/W1/MN1 added for the technical-analysis phase —
  // chooseTimeframe() below never selects them (unchanged: still only
  // M5/M15/H1), these entries exist only because CandleTimeframe now
  // includes them and this Record must stay exhaustive over the full enum.
  M30: 30 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
  W1: 7 * 24 * 60 * 60_000,
  MN1: 30 * 24 * 60 * 60_000,
  // Gold historical-collection phase — M1 added to CandleTimeframe for the
  // tick/candle backfill's finest granularity. chooseTimeframe() below
  // never selects it (unchanged: still only M5/M15/H1); this entry exists
  // only because this Record must stay exhaustive over the full enum.
  M1: 60_000,
};

// How many bars of context to show before entry / after exit — proportional
// to whatever timeframe was chosen for this trade's own duration, not a
// fixed wall-clock window (RECONSTRUCTION spec §3: "do not use one fixed
// number of candles if trade duration makes that meaningless").
const PRE_ENTRY_CONTEXT_BARS = 30;
const POST_EXIT_CONTEXT_BARS = 20;

/**
 * Historical chart reconstruction phase — timeframe choice, by the trade's
 * OWN duration: a scalping trade drowns in H1 candles (no visible detail),
 * a multi-day swing trade is unreadable as thousands of M5 bars. Three
 * buckets only, matching the timeframes this pass actually collects
 * (market-data module) — not a continuous function, so the mapping stays
 * predictable and testable.
 */
export function chooseTimeframe(durationMs: number): CandleTimeframe {
  const hours = durationMs / (60 * 60_000);
  if (hours <= 4) return 'M5';
  if (hours <= 48) return 'M15';
  return 'H1';
}

@Injectable()
export class TradeAlignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candles: HistoricalCandleService,
  ) {}

  /**
   * Pairs this account's IN/OUT deal rows for `symbol` into round trips —
   * same shape MT5 live deals and XTB-imported deals already share (both
   * write IN + OUT Trade rows keyed by the same positionId), so this works
   * identically regardless of platform. A position with only one leg
   * (still open, or a data gap) is excluded — a round trip needs both ends.
   */
  async getRoundTrips(accountId: string, symbol: string): Promise<RoundTripTrade[]> {
    const trades = await this.prisma.trade.findMany({
      where: { accountId, symbol, positionId: { not: null } },
      orderBy: { executedAt: 'asc' },
    });
    // Single account, so positionId alone is already an unambiguous pairing
    // key — no accountId prefix needed here.
    return this.pairRoundTrips(trades, (t) => t.positionId as string);
  }

  /**
   * Same IN/OUT pairing as `getRoundTrips`, but across every trading
   * account in the system rather than one — for `HistoricalPatternSummaryService`,
   * which represents the trader's OWN trading pattern (win rate, average
   * P&L) regardless of which account is currently being monitored live
   * (the user's own framing: "it doesn't matter which account I use... the
   * data history of mine"). `getRoundTrips` above stays account-scoped,
   * unchanged, for the EURUSD chart view, which legitimately shows one
   * specific account's own trades.
   *
   * Keys pairing by `accountId:positionId`, not `positionId` alone — MT5's
   * position_id and an XTB import's derived position id have no shared
   * uniqueness guarantee across different accounts, so without the account
   * prefix an IN leg from one account could theoretically pair with an OUT
   * leg from a different one.
   */
  async getAllRoundTrips(symbol: string): Promise<RoundTripTrade[]> {
    const trades = await this.prisma.trade.findMany({
      where: { symbol, positionId: { not: null } },
      orderBy: { executedAt: 'asc' },
    });
    return this.pairRoundTrips(trades, (t) => `${t.accountId}:${t.positionId}`);
  }

  private pairRoundTrips(
    trades: Awaited<ReturnType<PrismaService['trade']['findMany']>>,
    keyOf: (trade: (typeof trades)[number]) => string,
  ): RoundTripTrade[] {
    const byPosition = new Map<string, { in?: (typeof trades)[number]; out?: (typeof trades)[number] }>();
    for (const trade of trades) {
      const key = keyOf(trade);
      const entry = byPosition.get(key) ?? {};
      if (trade.dealEntry === 'IN') entry.in = trade;
      else if (trade.dealEntry === 'OUT') entry.out = trade;
      byPosition.set(key, entry);
    }

    const roundTrips: RoundTripTrade[] = [];
    for (const { in: inTrade, out: outTrade } of byPosition.values()) {
      if (!inTrade || !outTrade) continue;
      roundTrips.push({
        positionId: inTrade.positionId as string,
        side: inTrade.side,
        volume: inTrade.volume.toNumber(),
        entryTime: inTrade.executedAt,
        entryPrice: inTrade.price.toNumber(),
        exitTime: outTrade.executedAt,
        exitPrice: outTrade.price.toNumber(),
        profit: outTrade.profit.toNumber(),
        netProfit: outTrade.profit.toNumber() + outTrade.commission.toNumber() + outTrade.swap.toNumber(),
        stopLoss: (outTrade.stopLoss ?? inTrade.stopLoss)?.toNumber() ?? null,
        takeProfit: (outTrade.takeProfit ?? inTrade.takeProfit)?.toNumber() ?? null,
      });
    }

    return roundTrips.sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());
  }

  async getTradeChartWindow(accountId: string, symbol: string, positionId: string): Promise<TradeChartWindow> {
    const roundTrips = await this.getRoundTrips(accountId, symbol);
    const trip = roundTrips.find((t) => t.positionId === positionId);
    if (!trip) {
      throw new NotFoundException(`No closed ${symbol} round trip found for position ${positionId} on this account`);
    }

    const timeframe = chooseTimeframe(trip.exitTime.getTime() - trip.entryTime.getTime());
    const barDurationMs = CANDLE_DURATION_MS[timeframe];

    const idealWindowStart = new Date(trip.entryTime.getTime() - PRE_ENTRY_CONTEXT_BARS * barDurationMs);
    const idealWindowEnd = new Date(trip.exitTime.getTime() + POST_EXIT_CONTEXT_BARS * barDurationMs);

    const candleData = await this.candles.getCandlesInRange(symbol, timeframe, idealWindowStart, idealWindowEnd);

    // Anti-leakage trichotomy (RECONSTRUCTION spec §12): every candle falls
    // into exactly one bucket. "Pre-entry" is only ever a candle that fully
    // CLOSED at or before the entry moment — the entry candle itself (which
    // contains the entry tick) is never treated as "known before entry."
    const preEntryCandles = candleData.filter((c) => c.openTime.getTime() + barDurationMs <= trip.entryTime.getTime());
    const duringCandles = candleData.filter(
      (c) =>
        c.openTime.getTime() + barDurationMs > trip.entryTime.getTime() && c.openTime.getTime() < trip.exitTime.getTime(),
    );
    const postExitCandles = candleData.filter((c) => c.openTime.getTime() >= trip.exitTime.getTime());

    let dataLimitation: string | null = null;
    if (candleData.length === 0) {
      dataLimitation = `No historical ${symbol} ${timeframe} candles are available for this trade's window at all — the connected MT5 terminal may not have this symbol/timeframe backfilled, or its own history does not reach back this far.`;
    } else if (candleData[0].openTime.getTime() > idealWindowStart.getTime() + barDurationMs) {
      dataLimitation = `MT5's available history for ${symbol} ${timeframe} starts at ${candleData[0].openTime.toISOString()}, later than the ideal pre-entry context window start (${idealWindowStart.toISOString()}) — showing what's available rather than fabricating earlier candles.`;
    }

    return {
      positionId: trip.positionId,
      symbol,
      timeframe,
      side: trip.side,
      entryMarker: { time: trip.entryTime, price: trip.entryPrice },
      exitMarker: { time: trip.exitTime, price: trip.exitPrice, profit: trip.profit },
      stopLoss: trip.stopLoss,
      takeProfit: trip.takeProfit,
      candles: candleData,
      features: {
        preEntry: computePreEntryFeatures(preEntryCandles),
        duringTrade: computeDuringTradeFeatures(duringCandles, trip.side, trip.entryPrice),
        postExit: computePostExitFeatures(postExitCandles, trip.side, trip.exitPrice),
      },
      dataLimitation,
    };
  }
}
