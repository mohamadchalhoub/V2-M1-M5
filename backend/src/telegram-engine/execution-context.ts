/**
 * Gathering the facts one Telegram signal is judged against.
 *
 * The execution service queries for nothing, so this is the single place
 * those facts are assembled — and therefore the single place a wrong number
 * can come from.
 *
 * ## Every unknown blocks
 *
 * The governing rule, inherited deliberately from Engine A's equivalent: a
 * value that could not be established is never replaced by a plausible one. A
 * missing account snapshot, an unknown leverage, an unread point size — each
 * becomes a value the gates refuse, not a default that makes them pass.
 *
 * ## Margin is the shared-account question
 *
 * Both engines trade one MT5 account, so Engine B's free margin is whatever
 * the broker says is free AFTER Engine A's open M1 and M5 positions are
 * accounted for. That is exactly what the broker's own `freeMargin` figure
 * already is, which is why it is read from the account snapshot rather than
 * reconstructed by subtracting known exposure: the broker has already done
 * the arithmetic, across every position in the account including ones no
 * engine here owns.
 */
import type { PrismaClient } from '@prisma/client';
import { resolveQuote } from '../xauusd-m1m5/quote';
import { readQuoteCandidates } from '../xauusd-m1m5/quote-sources';
import type { M1M5Mt5SnapshotService } from '../xauusd-m1m5/mt5-snapshot.service';
import { configuredMaxAdverseEntryDeviationUsd } from './controls';
import type { TelegramExecutionContext } from './execution.service';
import { TELEGRAM_SPEC } from './spec';

export interface BuildTelegramContextInput {
  readonly prisma: PrismaClient;
  readonly snapshots: M1M5Mt5SnapshotService;
  readonly accountId: string;
  readonly nowMs: number;
  readonly expectedLoginId: string | null;
}

export interface BuiltTelegramContext {
  readonly context: TelegramExecutionContext;
  /** What could not be established, for the log and the dashboard. */
  readonly gaps: readonly string[];
}

export async function buildTelegramExecutionContext(
  input: BuildTelegramContextInput,
): Promise<BuiltTelegramContext> {
  const { prisma, accountId, nowMs } = input;
  const gaps: string[] = [];

  // --- The live quote, from the same two streams Engine A chooses between.
  // Reused rather than reimplemented because it is infrastructure: it encodes
  // how this deployment's tick tables represent time, which has nothing to do
  // with either strategy and has already been got wrong once.
  const candidates = await readQuoteCandidates(prisma);
  const resolved = resolveQuote(candidates, nowMs);
  const quote = resolved.quote
    ? { bid: resolved.quote.bid, ask: resolved.quote.ask, tickAtMs: resolved.quote.tickAtMs }
    : null;
  if (!quote) gaps.push(`no usable quote (${resolved.detail})`);

  // --- Broker contract terms, from what the collector actually read off the
  // symbol. Never the constants: those are the expectation, and a broker that
  // changed its terms must be caught rather than assumed away.
  const metadata = await prisma.symbolMetadata.findUnique({ where: { symbol: TELEGRAM_SPEC.symbol } });
  if (!metadata) gaps.push(`no SymbolMetadata row for ${TELEGRAM_SPEC.symbol}`);
  const pointSize = metadata ? Number(metadata.point) : 0;
  const constraints = {
    pointSize,
    tickSize: metadata?.tradeTickSize ? Number(metadata.tradeTickSize) : pointSize,
    stopLevelPoints: metadata?.tradeStopsLevel ?? 0,
    freezeLevelPoints: metadata?.tradeFreezeLevel ?? 0,
  };
  const contractSize = metadata ? Number(metadata.contractSize) : 0;
  if (contractSize <= 0) gaps.push('contract size unknown, so margin cannot be computed');

  // --- Terminal permissions and session state.
  const snapshot = await input.snapshots.latest(accountId);
  if (!snapshot) gaps.push('no MT5 permission snapshot');

  // --- Account state. Free margin is the broker's own figure, already net of
  // every open position in the shared account.
  const accountSnapshot = await prisma.accountSnapshot.findFirst({
    where: { accountId },
    orderBy: { capturedAt: 'desc' },
  });
  if (!accountSnapshot) gaps.push('no account snapshot; free margin is unknown');

  // --- Has reconciliation actually recovered broker state? Read, never
  // assumed. Absent row means no pass has ever run, which blocks.
  const recon = await prisma.telegramReconciliationState.findUnique({ where: { accountId } });
  const recoveryComplete = recon?.recoveryComplete === true;
  if (!recoveryComplete) {
    gaps.push(
      recon
        ? `reconciliation has not completed a recovery pass (${recon.detail ?? 'no detail'})`
        : 'the Telegram reconciliation worker has never completed a pass',
    );
  }

  // --- Whether the broker currently allows trading this symbol at all, as
  // distinct from whether its session is open.
  const symbolTradable = metadata ? tradabilityFromMetadata(metadata.tradeMode) : null;

  return {
    context: {
      accountId,
      nowMs,
      snapshot: snapshot?.permissions ?? null,
      expectedLoginId: input.expectedLoginId,
      symbolSessionOpen: snapshot?.sessionOpen ?? null,
      symbolTradable,
      quote,
      constraints,
      contractSize,
      leverage: snapshot?.leverage ?? null,
      freeMargin: accountSnapshot ? Number(accountSnapshot.freeMargin) : null,
      recoveryComplete,
      maxAdverseUsd: configuredMaxAdverseEntryDeviationUsd(),
    },
    gaps,
  };
}

/**
 * MT5's `SYMBOL_TRADE_MODE`, as the terminal reports it numerically:
 *
 *   0 DISABLED    no trading at all
 *   1 LONGONLY    only buys may be opened
 *   2 SHORTONLY   only sells may be opened
 *   3 CLOSEONLY   existing positions may be closed, none opened
 *   4 FULL        opening and closing permitted
 *
 * Only FULL permits what this engine does. The restricted modes are reported
 * as not tradable rather than half-supported: a copy engine that could take a
 * channel's SELL but not its BUY would silently trade a different strategy
 * from the one being copied.
 *
 * An absent or unrecognised value is null — unknown, which blocks — never a
 * guess in either direction.
 */
export const MT5_SYMBOL_TRADE_MODE_FULL = 4;
export const MT5_SYMBOL_TRADE_MODE_RESTRICTED = [0, 1, 2, 3];

export function tradabilityFromMetadata(tradeMode: number | null | undefined): boolean | null {
  if (tradeMode === null || tradeMode === undefined) return null;
  if (tradeMode === MT5_SYMBOL_TRADE_MODE_FULL) return true;
  if (MT5_SYMBOL_TRADE_MODE_RESTRICTED.includes(tradeMode)) return false;
  return null;
}
