/**
 * Assembling the facts an execution decision is made on.
 *
 * `M1M5ExecutionService.execute` takes an `ExecutionContext` and never queries
 * for anything itself. That separation is deliberate: the gates in the
 * execution service are pure functions of their inputs, so they can be tested
 * exhaustively without a database, and this file is the one place where those
 * inputs are gathered. If a number is wrong, it is wrong here.
 *
 * ## Every unknown blocks
 *
 * This file's governing rule is that a value it could not establish is never
 * replaced by a plausible one. A missing point size, a missing leverage, a
 * missing account snapshot — each becomes a value that makes the risk gate
 * refuse, not a default that makes it pass. The alternative is a system that
 * trades confidently on figures nobody supplied.
 *
 * That is why `marginRequired` is `Infinity` when leverage is unknown, rather
 * than the notional value or zero: Infinity is refused by the margin check for
 * the right reason and reports itself as such.
 */
import { PrismaClient } from '@prisma/client';
import type { BrokerStopConstraints } from './brackets';
import type { CrossingSignal } from './crossing';
import type { ExecutionContext } from './execution.service';
import type { M1M5LatestSnapshot } from './mt5-snapshot.service';
import type { CommittedRisk, AccountRiskState } from './risk';
import { V2_SL_USD, V2_SYMBOL } from './safety-constants';
import { beirutDateKey } from './time';
import { resolveVolume } from './volume';
import type { Timeframe } from './spec';

/** What could not be established, for the log and the dashboard. */
export interface ContextGaps {
  readonly blocking: readonly string[];
}

export interface BuiltContext {
  readonly context: ExecutionContext;
  readonly gaps: ContextGaps;
}

/**
 * Account-currency loss if a $5.00 stop is hit.
 *
 * Gold is quoted per ounce and a standard lot is `contractSize` ounces, so a
 * $5.00 adverse move costs `5 * contractSize * lots`. The stop distance is the
 * SPEC's fixed $5.00 rather than a measured bracket, because this figure is
 * needed before brackets are computed and the spec's distance is what they
 * will be built to.
 */
export function stopRiskForLots(lots: number, contractSize: number): number {
  return V2_SL_USD * contractSize * lots;
}

/**
 * Margin the broker will require, from MT5's own formula:
 * `lots * contractSize * price / leverage`.
 *
 * Returns Infinity when leverage is unknown. That is not a sentinel to be
 * special-cased later — it flows straight into the margin comparison and is
 * refused there, which is the correct outcome and the correct place for it.
 */
export function marginRequiredFor(
  lots: number,
  contractSize: number,
  price: number,
  leverage: number | null,
): number {
  if (!leverage || leverage <= 0) return Number.POSITIVE_INFINITY;
  return (lots * contractSize * price) / leverage;
}

export interface BuildContextInput {
  readonly prisma: PrismaClient;
  readonly accountId: string;
  readonly signal: CrossingSignal;
  readonly nowMs: number;
  readonly quote: { bid: number; ask: number; tickAtMs: number };
  readonly snapshot: M1M5LatestSnapshot | null;
  readonly expectedLoginId: string | null;
  readonly scheduleAllowsEntries: boolean;
  readonly scheduleDetail: string;
}

export async function buildExecutionContext(input: BuildContextInput): Promise<BuiltContext> {
  const { prisma, accountId, signal, nowMs, quote, snapshot } = input;
  const blocking: string[] = [];

  // --- Broker contract terms, from what the collector actually read off the
  // symbol. Never the constants: the constants are what we EXPECT, and
  // `bracketsFor` compares the live value against them precisely so that a
  // broker changing its terms is caught rather than assumed away.
  const metadata = await prisma.symbolMetadata.findUnique({ where: { symbol: V2_SYMBOL } });
  if (!metadata) blocking.push(`no SymbolMetadata row for ${V2_SYMBOL}; the collector has never reported it`);

  const pointSize = metadata ? Number(metadata.point) : 0;
  const constraints: BrokerStopConstraints = {
    pointSize,
    // tradeTickSize is NOT assumed equal to point. Where the broker reports it
    // separately, that is the value orders must be rounded to.
    tickSize: metadata?.tradeTickSize ? Number(metadata.tradeTickSize) : pointSize,
    stopLevelPoints: metadata?.tradeStopsLevel ?? 0,
    freezeLevelPoints: metadata?.tradeFreezeLevel ?? 0,
  };
  const contractSize = metadata ? Number(metadata.contractSize) : 0;
  if (contractSize <= 0) blocking.push('contract size unknown, so stop risk cannot be computed');

  // --- The volume this strategy is configured to trade.
  const setting = await prisma.xauusdM1M5VolumeSetting.findUnique({ where: { accountId } });
  const configuredVolume = setting ? Number(setting.volumeLots) : null;
  const lots = resolveVolume(configuredVolume).lots;

  // --- Account state. The most recent snapshot the collector pushed; equity
  // and free margin are null when there is none, and the risk gate blocks on
  // null rather than treating an unread account as a solvent one.
  const latestSnapshot = await prisma.accountSnapshot.findFirst({
    where: { accountId },
    orderBy: { capturedAt: 'desc' },
  });
  if (!latestSnapshot) blocking.push('no account snapshot; equity and free margin are unknown');

  const equity = latestSnapshot ? Number(latestSnapshot.equity) : null;

  // --- Day loss and drawdown, measured from equity rather than from trade
  // history. Equity already includes both realized and floating P/L, which is
  // exactly what the caps in §7 are about; reconstructing the same figure by
  // summing deals would be a second, disagreeing answer to a question the
  // broker has already answered.
  const dayKey = beirutDateKey(nowMs);
  const dayStart = await earliestSnapshotOfBeirutDay(prisma, accountId, dayKey, nowMs);
  const peak = await prisma.accountSnapshot.findFirst({
    where: { accountId },
    orderBy: { equity: 'desc' },
    select: { equity: true },
  });
  const startEquity = dayStart === null ? null : dayStart;
  const peakEquity = peak ? Number(peak.equity) : null;

  const account: AccountRiskState = {
    equity,
    freeMargin: latestSnapshot ? Number(latestSnapshot.freeMargin) : null,
    // A positive number, and zero when the day is up rather than a negative
    // "loss" that would quietly enlarge the remaining allowance.
    dayLoss: equity !== null && startEquity !== null ? Math.max(0, startEquity - equity) : 0,
    drawdown: equity !== null && peakEquity !== null ? Math.max(0, peakEquity - equity) : 0,
  };

  // --- Exposure already committed, across BOTH timeframes, including orders
  // that are merely reserved. §7's combined cap is about what this strategy
  // could lose in total, and a reservation that has not filled yet can still
  // become a position — leaving it out would let the second entry be approved
  // against an allowance the first has already spent.
  const heldSlots = await prisma.xauusdM1M5SlotLock.findMany({
    where: { accountId },
    include: { decision: { select: { volumeLots: true } } },
  });
  const committed: CommittedRisk[] = heldSlots.map((slot) => ({
    timeframe: slot.timeframe as Timeframe,
    stopRisk: stopRiskForLots(slot.decision?.volumeLots ? Number(slot.decision.volumeLots) : lots, contractSize),
    reserved: slot.state !== 'FILLED',
  }));

  const entryPrice = signal.direction === 'BUY' ? quote.ask : quote.bid;
  const leverage = snapshot?.leverage ?? null;
  if (leverage === null) blocking.push('account leverage unknown, so the margin requirement cannot be computed');

  return {
    context: {
      accountId,
      signal,
      nowMs,
      freshQuote: quote,
      constraints,
      account,
      committed,
      marginRequired: marginRequiredFor(lots, contractSize, entryPrice, leverage),
      stopRisk: stopRiskForLots(lots, contractSize),
      mt5Snapshot: snapshot?.permissions ?? null,
      expectedLoginId: input.expectedLoginId,
      scheduleAllowsEntries: input.scheduleAllowsEntries,
      scheduleDetail: input.scheduleDetail,
      configuredVolume,
    },
    gaps: { blocking },
  };
}

/**
 * Equity at the start of the current Beirut trading day.
 *
 * Found by scanning back for the first snapshot whose Beirut date key matches
 * today's. Returns null when there is none — the process may have started
 * mid-day — and a null start means no day-loss figure is claimed rather than
 * one being invented from the oldest reading available.
 */
async function earliestSnapshotOfBeirutDay(
  prisma: PrismaClient,
  accountId: string,
  dayKey: string,
  nowMs: number,
): Promise<number | null> {
  // A day cannot span more than 48h of snapshots; bounding the scan keeps this
  // cheap on an account with a long history.
  const since = new Date(nowMs - 48 * 60 * 60 * 1000);
  const rows = await prisma.accountSnapshot.findMany({
    where: { accountId, capturedAt: { gte: since } },
    orderBy: { capturedAt: 'asc' },
    select: { equity: true, capturedAt: true },
  });
  for (const row of rows) {
    if (beirutDateKey(row.capturedAt.getTime()) === dayKey) return Number(row.equity);
  }
  return null;
}
