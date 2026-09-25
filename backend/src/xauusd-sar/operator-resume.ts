/**
 * Operator resume of TODAY's SAR session after an operator/emergency flatten.
 *
 * `closeForDay` leaves the session DAILY_CLOSED for the rest of the Beirut
 * day, and nothing in the normal lifecycle reopens it. This is the one
 * explicit, guarded way to return today's session to WAIT_MARKET_OPEN — the
 * state `ensureSession` creates every morning — so the normal scheduler path
 * (initializeSession with a fresh quote, then evaluateTick) continues from
 * there. It never places an order, never touches order attempts, cycles or
 * any other history, and refuses unless every safety precondition holds.
 */
import type { PrismaClient } from '@prisma/client';
import { readQuoteCandidates } from '../xauusd-m1m5/quote-sources';
import { resolveQuote } from '../xauusd-m1m5/quote';
import { M1M5Mt5SnapshotService } from '../xauusd-m1m5/mt5-snapshot.service';
import { sarKillSwitchState } from './controls';
import { SAR_MAGIC, SAR_SYMBOL } from './safety-constants';
import { isWithinDailyClose, localDateInZone } from './spec';

/** The collector reports every poll cycle (~10s); anything older is not "healthy". */
export const RESUME_MAX_SNAPSHOT_AGE_MS = 60_000;
/** Attempts younger than this that are not finished count as outstanding. */
export const RESUME_OUTSTANDING_ATTEMPT_WINDOW_MS = 12 * 60 * 60_000;
const SYMBOL_TRADE_MODE_FULL = 4;

export interface ResumeFacts {
  readonly nowMs: number;
  readonly sessionState: string | null;
  readonly sessionDate: string | null;
  readonly todayBeirut: string;
  readonly withinDailyClose: boolean;
  readonly killSwitchOn: boolean;
  readonly snapshotAgeMs: number | null;
  readonly tradeMode: string | null;
  readonly terminalConnected: boolean | null;
  readonly terminalTradeAllowed: boolean | null;
  readonly accountTradeAllowed: boolean | null;
  readonly sessionOpen: boolean | null;
  readonly symbolTradeMode: number | null;
  readonly quoteFresh: boolean;
  readonly brokerSarPositions: number;
  readonly outstandingAttempts: number;
}

export function evaluateResume(f: ResumeFacts): string[] {
  const refusals: string[] = [];
  if (f.tradeMode !== 'DEMO') refusals.push(`account trade mode is ${f.tradeMode ?? 'unknown'}, not DEMO`);
  if (f.sessionState !== 'DAILY_CLOSED') refusals.push(`session state is ${f.sessionState ?? 'missing'}, not DAILY_CLOSED`);
  if (f.sessionDate !== f.todayBeirut) refusals.push(`session date ${f.sessionDate ?? 'missing'} is not today (${f.todayBeirut} Beirut)`);
  if (f.withinDailyClose) refusals.push('inside the 23:40–01:00 Beirut daily-close window');
  if (!f.killSwitchOn) refusals.push('kill switch is OFF; resume is only allowed with the kill switch ON');
  if (f.snapshotAgeMs === null || f.snapshotAgeMs > RESUME_MAX_SNAPSHOT_AGE_MS) {
    refusals.push(`collector snapshot is ${f.snapshotAgeMs === null ? 'missing' : `${Math.round(f.snapshotAgeMs / 1000)}s old`}; collector not healthy`);
  }
  if (f.terminalConnected !== true) refusals.push('MT5 terminal is not reported connected');
  if (f.terminalTradeAllowed !== true) refusals.push('terminal trade_allowed is not true');
  if (f.accountTradeAllowed !== true) refusals.push('account trade_allowed is not true');
  if (f.sessionOpen !== true) refusals.push('XAUUSD market session is not reported open');
  if (f.symbolTradeMode !== SYMBOL_TRADE_MODE_FULL) refusals.push(`XAUUSD trade mode is ${f.symbolTradeMode ?? 'unknown'}, not FULL (4)`);
  if (!f.quoteFresh) refusals.push('XAUUSD quote is not fresh');
  if (f.brokerSarPositions !== 0) refusals.push(`broker reports ${f.brokerSarPositions} open SAR-magic position(s)`);
  if (f.outstandingAttempts !== 0) refusals.push(`${f.outstandingAttempts} outstanding SAR order attempt(s)`);
  return refusals;
}

export interface ResumeResult {
  readonly resumed: boolean;
  readonly refusals: readonly string[];
  readonly facts: ResumeFacts;
}

export async function gatherResumeFacts(prisma: PrismaClient, accountId: string, nowMs: number): Promise<ResumeFacts> {
  const session = await prisma.xauusdSarSession.findUnique({ where: { accountId } });
  const snapshot = await new M1M5Mt5SnapshotService(prisma as never).latest(accountId);
  const symbol = await prisma.symbolMetadata.findUnique({ where: { symbol: SAR_SYMBOL } });
  const quote = resolveQuote(await readQuoteCandidates(prisma), nowMs);
  const openPositions = await prisma.position.findMany({ where: { accountId, symbol: SAR_SYMBOL, status: 'OPEN' } });
  const brokerSarPositions = openPositions.filter((p) => Number((p.rawPayload as { magic?: unknown } | null)?.magic) === SAR_MAGIC).length;
  const outstandingAttempts = await prisma.xauusdSarOrderAttempt.count({
    where: {
      accountId,
      status: { in: ['PENDING', 'SENT', 'UNKNOWN'] },
      OR: [{ claimedAt: null }, { requestedAt: { gt: new Date(nowMs - RESUME_OUTSTANDING_ATTEMPT_WINDOW_MS) } }],
    },
  });
  return {
    nowMs,
    sessionState: session?.state ?? null,
    sessionDate: session?.sessionDate ?? null,
    todayBeirut: localDateInZone(nowMs),
    withinDailyClose: isWithinDailyClose(nowMs),
    killSwitchOn: sarKillSwitchState().active,
    snapshotAgeMs: snapshot ? nowMs - snapshot.permissions.capturedAtMs : null,
    tradeMode: snapshot?.permissions.tradeMode ?? null,
    terminalConnected: snapshot?.permissions.terminalConnected ?? null,
    terminalTradeAllowed: snapshot?.permissions.terminalTradeAllowed ?? null,
    accountTradeAllowed: snapshot?.permissions.accountTradeAllowed ?? null,
    sessionOpen: snapshot?.sessionOpen ?? null,
    symbolTradeMode: symbol?.tradeMode ?? null,
    quoteFresh: quote.quote?.fresh === true,
    brokerSarPositions,
    outstandingAttempts,
  };
}

export async function operatorResumeSession(prisma: PrismaClient, accountId: string, nowMs: number): Promise<ResumeResult> {
  const facts = await gatherResumeFacts(prisma, accountId, nowMs);
  const refusals = evaluateResume(facts);
  if (refusals.length > 0) return { resumed: false, refusals, facts };

  // Guarded on the exact state and date just verified, so a concurrent
  // change (a new day, another operator) makes this a no-op, not a clobber.
  const updated = await prisma.xauusdSarSession.updateMany({
    where: { accountId, state: 'DAILY_CLOSED', sessionDate: facts.todayBeirut },
    data: {
      state: 'WAIT_MARKET_OPEN',
      sessionReference: null,
      initialBuyTrigger: null,
      initialSellTrigger: null,
      referenceCapturedAt: null,
      cycleId: null,
      direction: null,
      entryFillPrice: null,
      extremeSinceEntry: null,
      reversalLevel: null,
      brokerTicket: null,
      unknownSince: null,
    },
  });
  if (updated.count !== 1) return { resumed: false, refusals: ['session changed while resuming; nothing done'], facts };
  return { resumed: true, refusals: [], facts };
}
