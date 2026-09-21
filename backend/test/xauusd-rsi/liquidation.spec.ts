/**
 * Friday pre-weekend liquidation (spec §9.3).
 *
 * The properties under test are the ones with real consequences:
 *
 *   - it acts only on exposure this application OWNS;
 *   - it never reports success without broker evidence;
 *   - it never submits a duplicate close for a position already being closed;
 *   - a missed deadline becomes a durable, named failure, not silence.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { RsiAccountStateService } from '../../src/xauusd-rsi/account-state.service';
import { RsiLiquidationService } from '../../src/xauusd-rsi/liquidation.service';
import { ARCHIVED_H4_CONFIRMED_RETEST_OWNER } from '../../src/xauusd-rsi/ownership';
import { RSI_MAGIC_EXTREME, RSI_MAGIC_RETEST } from '../../src/xauusd-rsi/safety-constants';

/** Friday 2026-09-25, 23:05 Beirut — past the 23:00 cutoff, before the 23:30 deadline. */
const FRIDAY_LIQUIDATION_T = Date.parse('2026-09-25T20:05:00.000Z');
/** Friday 2026-09-25, 23:35 Beirut — past the deadline. */
const FRIDAY_PAST_DEADLINE_T = Date.parse('2026-09-25T20:35:00.000Z');
/** Saturday 2026-09-26, 12:00 Beirut — a weekend restart. */
const WEEKEND_T = Date.parse('2026-09-26T09:00:00.000Z');
/** Wednesday 2026-09-23, 15:00 Beirut — an ordinary trading afternoon. */
const ORDINARY_T = Date.parse('2026-09-23T12:00:00.000Z');

describe('Friday liquidation', () => {
  let prisma: PrismaClient;
  let service: RsiLiquidationService;
  let accountId: string;

  beforeAll(() => {
    prisma = new PrismaClient();
    service = new RsiLiquidationService(prisma as never, new RsiAccountStateService(prisma as never));
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    accountId = account.id;
  });

  async function openPosition(ticket: string, magic: number | null, side: 'BUY' | 'SELL' = 'BUY') {
    return prisma.position.create({
      data: {
        accountId, platform: 'MT5', externalPositionId: ticket, symbol: 'XAUUSD',
        side, volume: 0.5, openPrice: 4345, profit: 0, swap: 0,
        openedAt: new Date(ORDINARY_T), status: 'OPEN',
        rawPayload: magic === null ? {} : { magic },
      },
    });
  }

  it('does nothing on an ordinary weekday', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST);
    const result = await service.runCycle(accountId, ORDINARY_T);

    expect(result.phase).toBe('NOT_DUE');
    expect(result.closeRequestsCreated).toHaveLength(0);
    expect(await prisma.goldCloseRequest.count()).toBe(0);
  });

  it('starts at the Friday cutoff and submits a close for an owned position', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST);
    const result = await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);

    expect(result.phase).toBe('IN_PROGRESS');
    expect(result.closeRequestsCreated).toHaveLength(1);

    const req = await prisma.goldCloseRequest.findFirstOrThrow();
    expect(req.positionTicket).toBe('1001');
    expect(req.symbol).toBe('XAUUSD');
    expect(req.status).toBe('PENDING');

    // The item is SUBMITTED, not cleared — a request is not evidence.
    const item = await prisma.xauusdRsiLiquidationItem.findFirstOrThrow();
    expect(item.status).toBe('SUBMITTED');
    expect(item.attempts).toBe(1);
    expect(item.clearedAt).toBeNull();
  });

  it('also liquidates a position left by the RETIRED strategy, which this application still owns', async () => {
    await openPosition('2002', ARCHIVED_H4_CONFIRMED_RETEST_OWNER.magicNumber);
    const result = await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);

    expect(result.closeRequestsCreated).toHaveLength(1);
    expect(result.outstanding[0].ownership).toMatch(/Archived H4/);
  });

  it('never closes a FOREIGN position, and reports it separately', async () => {
    await openPosition('9999', 777777); // not a registered magic
    const result = await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);

    expect(await prisma.goldCloseRequest.count()).toBe(0);
    expect(result.foreignExposure).toHaveLength(1);
    expect(result.foreignExposure[0].ticket).toBe('9999');
    // With no OWNED exposure, owned exposure is flat — but that is explicitly
    // NOT a claim that the account is flat.
    expect(result.ownedExposureFlat).toBe(true);
    expect(result.phase).toBe('CONFIRMED_FLAT');
  });

  it('never closes a manual position with no magic number at all', async () => {
    await openPosition('8888', null);
    await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);
    expect(await prisma.goldCloseRequest.count()).toBe(0);
  });

  it('does not submit a second close while one is already in flight', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST);
    await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);
    expect(await prisma.goldCloseRequest.count()).toBe(1);

    // A second cycle immediately afterwards must not duplicate the request —
    // this is what stops this worker and the protection-remediation worker
    // from both closing the same position.
    const second = await service.runCycle(accountId, FRIDAY_LIQUIDATION_T + 1_000);
    expect(second.closeRequestsCreated).toHaveLength(0);
    expect(await prisma.goldCloseRequest.count()).toBe(1);
    expect(second.notes.join(' ')).toMatch(/already in flight/);
  });

  it('confirms clearance ONLY when the position is gone from broker data', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST);
    await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);

    // Marking the close request CLOSED is NOT enough on its own.
    await prisma.goldCloseRequest.updateMany({ data: { status: 'CLOSED', closedAt: new Date() } });
    const stillThere = await service.runCycle(accountId, FRIDAY_LIQUIDATION_T + 60_000);
    expect(stillThere.ownedExposureFlat).toBe(false);
    expect(stillThere.phase).toBe('IN_PROGRESS');

    // Now the broker no longer reports the position.
    await prisma.position.updateMany({ where: { externalPositionId: '1001' }, data: { status: 'CLOSED' } });
    const gone = await service.runCycle(accountId, FRIDAY_LIQUIDATION_T + 120_000);

    expect(gone.confirmedCleared).toContain('1001');
    expect(gone.ownedExposureFlat).toBe(true);
    expect(gone.phase).toBe('CONFIRMED_FLAT');

    const item = await prisma.xauusdRsiLiquidationItem.findFirstOrThrow();
    expect(item.status).toBe('CONFIRMED_CLEARED');
    expect(item.clearedAt).not.toBeNull();
  });

  it('records a durable failure and a critical incident when the deadline passes with exposure remaining', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST);
    await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);

    const missed = await service.runCycle(accountId, FRIDAY_PAST_DEADLINE_T);

    expect(missed.phase).toBe('DEADLINE_MISSED');
    expect(missed.criticalIncident).toMatch(/FRIDAY CLOSURE DEADLINE MISSED/);
    // The incident must NAME what remains, not just say something went wrong.
    expect(missed.criticalIncident).toMatch(/1001/);
    expect(missed.criticalIncident).toMatch(/no position is assumed to have closed/);

    const item = await prisma.xauusdRsiLiquidationItem.findFirstOrThrow();
    expect(item.status).toBe('FAILED');
    expect(item.lastError).toMatch(/deadline passed/);
  });

  it('does not report a miss when exposure was confirmed gone before the deadline', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST);
    await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);
    await prisma.position.updateMany({ where: { externalPositionId: '1001' }, data: { status: 'CLOSED' } });
    await service.runCycle(accountId, FRIDAY_LIQUIDATION_T + 60_000);

    const after = await service.runCycle(accountId, FRIDAY_PAST_DEADLINE_T);
    expect(after.phase).toBe('CONFIRMED_FLAT');
    expect(after.criticalIncident).toBeNull();
  });

  it('still drives liquidation after a weekend restart with exposure remaining', async () => {
    // Nothing ran on Friday — the machine was off. Starting on Saturday must
    // pick the obligation up from real state rather than depend on a callback.
    await openPosition('1001', RSI_MAGIC_RETEST);

    const result = await service.runCycle(accountId, WEEKEND_T);

    expect(result.phase).toBe('DEADLINE_MISSED');
    expect(result.criticalIncident).toMatch(/1001/);
    // It still submits a close: the obligation does not expire with the deadline.
    expect(await prisma.goldCloseRequest.count()).toBe(1);
  });

  it('keeps one liquidation item per ticket per deadline across repeated cycles', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST);
    for (let i = 0; i < 5; i += 1) {
      await service.runCycle(accountId, FRIDAY_LIQUIDATION_T + i * 1_000);
    }
    expect(await prisma.xauusdRsiLiquidationItem.count()).toBe(1);
  });

  it('liquidates BOTH family slots when both hold a position', async () => {
    // The Friday deadline applies to every owned position, and with two slots
    // that can mean two simultaneous closes.
    await openPosition('1001', RSI_MAGIC_RETEST, 'BUY');
    await openPosition('1002', RSI_MAGIC_EXTREME, 'SELL');

    const result = await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);

    expect(result.closeRequestsCreated).toHaveLength(2);
    const requests = await prisma.goldCloseRequest.findMany({ orderBy: { positionTicket: 'asc' } });
    expect(requests.map((r) => r.positionTicket)).toEqual(['1001', '1002']);
    // Each close carries its own position's real side.
    expect(requests[0].side).toBe('BUY');
    expect(requests[1].side).toBe('SELL');
    expect(result.outstanding.map((o) => o.ownership).join(' ')).toMatch(/RETEST/);
    expect(result.outstanding.map((o) => o.ownership).join(' ')).toMatch(/EXTREME/);
  });

  it('reports a deadline miss naming BOTH remaining slots', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST);
    await openPosition('1002', RSI_MAGIC_EXTREME);
    await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);

    const missed = await service.runCycle(accountId, FRIDAY_PAST_DEADLINE_T);
    expect(missed.phase).toBe('DEADLINE_MISSED');
    expect(missed.criticalIncident).toMatch(/1001/);
    expect(missed.criticalIncident).toMatch(/1002/);
  });

  it('handles several owned positions independently', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST, 'BUY');
    await openPosition('1002', ARCHIVED_H4_CONFIRMED_RETEST_OWNER.magicNumber, 'SELL');
    await openPosition('9999', 777777); // foreign, must be untouched

    const result = await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);

    expect(result.closeRequestsCreated).toHaveLength(2);
    const tickets = (await prisma.goldCloseRequest.findMany()).map((r) => r.positionTicket).sort();
    expect(tickets).toEqual(['1001', '1002']);
    expect(result.foreignExposure.map((f) => f.ticket)).toEqual(['9999']);
  });

  it('carries the position’s real side and volume into the close request', async () => {
    await openPosition('1001', RSI_MAGIC_RETEST, 'SELL');
    await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);

    const req = await prisma.goldCloseRequest.findFirstOrThrow();
    expect(req.side).toBe('SELL');
    expect(req.volume.toNumber()).toBe(0.5);
  });

  it('reconciles a cleared item even when liquidation is not due', async () => {
    // A position closed by its own take-profit during the week must not leave
    // a stale OUTSTANDING row behind for the next Friday to trip over.
    await openPosition('1001', RSI_MAGIC_RETEST);
    await service.runCycle(accountId, FRIDAY_LIQUIDATION_T);
    await prisma.position.updateMany({ where: { externalPositionId: '1001' }, data: { status: 'CLOSED' } });

    const midweek = await service.runCycle(accountId, ORDINARY_T);
    expect(midweek.phase).toBe('NOT_DUE');
    expect(midweek.confirmedCleared).toContain('1001');
  });
});
