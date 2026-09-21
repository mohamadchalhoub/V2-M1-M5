/**
 * Fill -> full closure -> slot release, reconstructed from the real incident.
 *
 * What actually happened on 2026-09-21:
 *
 *   02:46:15 Beirut  BUY_TROUGH_RETEST observed, RSI 8.33 returning to a
 *                    frozen trough of 8.5295
 *   02:46:17         decision 966bf32f evaluated, approved, SENT
 *   02:46:24         broker filled it as ticket 58537207521 at 4369.96,
 *                    SL 4364.96 / TP 4374.96, comment "rsi-966bf32f"
 *                    -- and the backend REJECTED the collector's report,
 *                    because mt5_ticket was INT4 and the ticket has 11
 *                    digits. Decision stayed SENT with a null ticket.
 *   03:11:18         full-volume SELL OUT at the stop loss; position closed
 *   03:17:58 and
 *   03:18:25         two further RETEST signals SKIPPED, because a decision
 *                    with a null ticket can never release its slot
 *
 * Two independent defects, so two independent guards are needed: the ticket
 * must fit (covered in execution-e2e), and a holder that lost its ticket must
 * still be resolvable from broker evidence. The second is what this file is
 * about.
 *
 * The releases here are all driven by POSITIVE evidence. Absence of a
 * position is deliberately NOT treated as closure.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { RsiAccountStateService } from '../../src/xauusd-rsi/account-state.service';
import { RsiDecisionService } from '../../src/xauusd-rsi/decision.service';
import { RSI_MAGIC_EXTREME, RSI_MAGIC_RETEST } from '../../src/xauusd-rsi/safety-constants';

/** The real ticket. Eleven digits, well beyond INT4. */
const TICKET = '58537207521';
const OPENED_AT = new Date('2026-09-20T23:46:24.000Z'); // 02:46:24 Beirut

describe('RETEST slot release after a broker-confirmed full closure', () => {
  let prisma: PrismaClient;
  let decisions: RsiDecisionService;
  let accountState: RsiAccountStateService;
  let accountId: string;

  beforeAll(() => {
    prisma = new PrismaClient();
    accountState = new RsiAccountStateService(prisma as never);
    decisions = new RsiDecisionService(prisma as never, accountState);
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

  /** A decision holding its family's slot. */
  async function holder(opts: {
    orderStatus: 'SENT' | 'UNKNOWN' | 'FILLED';
    ticket: string | null;
    ruleFamily?: 'RETEST' | 'EXTREME';
  }) {
    return prisma.xauusdRsiDecision.create({
      data: {
        strategyVersion: 'xauusd-m1-rsi-retest-extremes-v1',
        specHash: 'f189d2bb39ab8a5d',
        accountId,
        symbol: 'XAUUSD',
        observedAt: new Date('2026-09-20T23:46:15.208Z'),
        evaluatedAt: new Date('2026-09-20T23:46:17.379Z'),
        direction: 'BUY',
        ruleFamily: opts.ruleFamily ?? 'RETEST',
        magicNumber: (opts.ruleFamily ?? 'RETEST') === 'RETEST' ? RSI_MAGIC_RETEST : RSI_MAGIC_EXTREME,
        setupKinds: ['BUY_TROUGH_RETEST'],
        eventId: `evt-${Math.random()}`,
        rsiValue: 8.33076907,
        previousRsi: 8.57500489,
        basisPrice: 4369.39,
        observationMode: 'TICK',
        entryPrice: 4370.13,
        stopLoss: 4365.13,
        takeProfit: 4375.13,
        volumeLots: 0.5,
        requestedPrice: 4370.13,
        reasoning: 'incident reconstruction',
        evidence: {},
        approved: true,
        orderStatus: opts.orderStatus,
        mt5Ticket: opts.ticket === null ? null : BigInt(opts.ticket),
        slotReleasedAt: null,
      },
    });
  }

  /** The broker's own record of the position this strategy opened. */
  async function brokerPosition(opts: {
    status: 'OPEN' | 'CLOSED';
    comment: string;
    magic?: number;
    volume?: number;
    ticket?: string;
  }) {
    return prisma.position.create({
      data: {
        accountId,
        platform: 'MT5',
        externalPositionId: opts.ticket ?? TICKET,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: opts.volume ?? 0.5,
        openPrice: 4369.96,
        currentPrice: 4364.96,
        stopLoss: 4364.96,
        takeProfit: 4374.96,
        profit: -153.77,
        swap: 0,
        status: opts.status,
        openedAt: OPENED_AT,
        rawPayload: {
          ticket: Number(opts.ticket ?? TICKET),
          magic: opts.magic ?? RSI_MAGIC_RETEST,
          comment: opts.comment,
          volume: opts.volume ?? 0.5,
          price_open: 4369.96,
          sl: 4364.96,
          tp: 4374.96,
        },
      },
    });
  }

  it('THE INCIDENT: a SENT decision with no ticket is attributed and released once the broker confirms closure', async () => {
    const decision = await holder({ orderStatus: 'SENT', ticket: null });
    await brokerPosition({ status: 'CLOSED', comment: `rsi-${decision.id.slice(0, 8)}` });

    // No live tickets: the broker reports nothing open.
    const released = await decisions.releaseSlotsForClosedPositions(accountId, new Set());

    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(after.orderStatus).toBe('FILLED');
    expect(String(after.mt5Ticket)).toBe(TICKET);
    expect(after.slotReleasedAt).not.toBeNull();
    expect(after.filledPrice?.toNumber()).toBeCloseTo(4369.96, 6);
    // 4369.96 vs requested 4370.13 = 17 points of slippage, recorded not inferred.
    expect(after.slippagePoints?.toNumber()).toBeCloseTo(17, 3);
    expect(after.executionError).toMatch(/Reconciled against broker evidence/);
    expect(released.join(' ')).toContain(TICKET);

    const slots = await accountState.resolveSlotStates(accountId);
    expect(slots.RETEST.occupied).toBe(false);
  });

  it('attributes only on the strategy comment AND the family magic together', async () => {
    const decision = await holder({ orderStatus: 'SENT', ticket: null });
    // Right comment, but the EXTREME magic — not this family's position.
    await brokerPosition({ status: 'CLOSED', comment: `rsi-${decision.id.slice(0, 8)}`, magic: RSI_MAGIC_EXTREME });

    await decisions.releaseSlotsForClosedPositions(accountId, new Set());

    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(after.mt5Ticket).toBeNull();
    expect(after.slotReleasedAt).toBeNull();
  });

  it("does not attach another decision's position", async () => {
    const decision = await holder({ orderStatus: 'SENT', ticket: null });
    await brokerPosition({ status: 'CLOSED', comment: 'rsi-deadbeef' });

    await decisions.releaseSlotsForClosedPositions(accountId, new Set());

    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(after.mt5Ticket).toBeNull();
    expect(after.slotReleasedAt).toBeNull();
  });

  it('holds the slot while the position is still OPEN', async () => {
    const decision = await holder({ orderStatus: 'FILLED', ticket: TICKET });
    await brokerPosition({ status: 'OPEN', comment: `rsi-${decision.id.slice(0, 8)}` });

    await decisions.releaseSlotsForClosedPositions(accountId, new Set([TICKET]));

    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(after.slotReleasedAt).toBeNull();
    expect((await accountState.resolveSlotStates(accountId)).RETEST.occupied).toBe(true);
  });

  it('holds the slot after a PARTIAL close, because exposure remains', async () => {
    const decision = await holder({ orderStatus: 'FILLED', ticket: TICKET });
    // Half closed: the broker still reports an open position, at 0.25.
    await brokerPosition({ status: 'OPEN', comment: `rsi-${decision.id.slice(0, 8)}`, volume: 0.25 });

    await decisions.releaseSlotsForClosedPositions(accountId, new Set([TICKET]));

    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(after.slotReleasedAt).toBeNull();
  });

  it('does NOT treat an absent position as proof of closure', async () => {
    // Filled, with a ticket, but no stored position at all and nothing live.
    // A snapshot that never arrived must not read as "the trade is over".
    const decision = await holder({ orderStatus: 'FILLED', ticket: TICKET });

    const released = await decisions.releaseSlotsForClosedPositions(accountId, new Set());

    expect(released).toHaveLength(0);
    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(after.slotReleasedAt).toBeNull();
  });

  it('keeps holding an unattributable in-flight decision — no broker evidence either way', async () => {
    const decision = await holder({ orderStatus: 'UNKNOWN', ticket: null });

    await decisions.releaseSlotsForClosedPositions(accountId, new Set());

    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(after.orderStatus).toBe('UNKNOWN');
    expect(after.slotReleasedAt).toBeNull();
    expect((await accountState.resolveSlotStates(accountId)).RETEST.occupied).toBe(true);
  });

  it('a live ticket always wins over a stale stored row claiming closure', async () => {
    const decision = await holder({ orderStatus: 'FILLED', ticket: TICKET });
    await brokerPosition({ status: 'CLOSED', comment: `rsi-${decision.id.slice(0, 8)}` });

    // The broker says it is open right now; the stored row is behind.
    await decisions.releaseSlotsForClosedPositions(accountId, new Set([TICKET]));

    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(after.slotReleasedAt).toBeNull();
  });

  it('releasing one family leaves the other untouched', async () => {
    const retest = await holder({ orderStatus: 'FILLED', ticket: TICKET, ruleFamily: 'RETEST' });
    const extreme = await holder({ orderStatus: 'FILLED', ticket: '58537207522', ruleFamily: 'EXTREME' });
    await brokerPosition({ status: 'CLOSED', comment: `rsi-${retest.id.slice(0, 8)}` });
    await brokerPosition({
      status: 'OPEN', comment: `rsi-${extreme.id.slice(0, 8)}`,
      magic: RSI_MAGIC_EXTREME, ticket: '58537207522',
    });

    await decisions.releaseSlotsForClosedPositions(accountId, new Set(['58537207522']));

    const slots = await accountState.resolveSlotStates(accountId);
    expect(slots.RETEST.occupied).toBe(false);
    expect(slots.EXTREME.occupied).toBe(true);
  });

  it('is idempotent — a second pass neither re-releases nor re-attributes', async () => {
    const decision = await holder({ orderStatus: 'SENT', ticket: null });
    await brokerPosition({ status: 'CLOSED', comment: `rsi-${decision.id.slice(0, 8)}` });

    const first = await decisions.releaseSlotsForClosedPositions(accountId, new Set());
    const releasedAt = (await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } })).slotReleasedAt;

    const second = await decisions.releaseSlotsForClosedPositions(accountId, new Set());

    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(after.slotReleasedAt?.getTime()).toBe(releasedAt?.getTime());
  });

  it('does not resurrect the signals that were skipped while the slot was held', async () => {
    const decision = await holder({ orderStatus: 'SENT', ticket: null });
    await brokerPosition({ status: 'CLOSED', comment: `rsi-${decision.id.slice(0, 8)}` });

    // The two real skips at 03:17:58 and 03:18:25 Beirut.
    for (const [i, at] of [['2026-09-21T00:17:58.000Z'], ['2026-09-21T00:18:25.000Z']].flat().entries()) {
      await prisma.xauusdRsiDecision.create({
        data: {
          strategyVersion: 'xauusd-m1-rsi-retest-extremes-v1', specHash: 'f189d2bb39ab8a5d',
          accountId, symbol: 'XAUUSD',
          observedAt: new Date(at), evaluatedAt: new Date(at),
          direction: 'BUY', ruleFamily: 'RETEST', setupKinds: ['BUY_TROUGH_RETEST'],
          eventId: `skipped-${i}`, rsiValue: 9, previousRsi: 9.5, basisPrice: 4366,
          magicNumber: RSI_MAGIC_RETEST,
          observationMode: 'TICK', reasoning: 'skipped while the slot was held', evidence: {},
          approved: false, orderStatus: 'NONE',
          skipReason: 'RETEST slot already held',
          slotReleasedAt: new Date(at),
        },
      });
    }

    await decisions.releaseSlotsForClosedPositions(accountId, new Set());

    // Still skipped, still unapproved, still no order. Releasing a slot is
    // not a replay: a missed intrabar signal is gone, not deferred.
    const skipped = await prisma.xauusdRsiDecision.findMany({
      where: { accountId, skipReason: 'RETEST slot already held' },
    });
    expect(skipped).toHaveLength(2);
    expect(skipped.every((s) => s.orderStatus === 'NONE' && s.approved === false)).toBe(true);
  });

  it('a genuinely NEW signal can take the freed slot afterwards', async () => {
    const decision = await holder({ orderStatus: 'SENT', ticket: null });
    await brokerPosition({ status: 'CLOSED', comment: `rsi-${decision.id.slice(0, 8)}` });
    await decisions.releaseSlotsForClosedPositions(accountId, new Set());

    expect((await accountState.resolveSlotStates(accountId)).RETEST.occupied).toBe(false);

    // The partial unique index is what enforces one holder per family; a new
    // insert succeeding is the real proof the reservation is gone.
    const fresh = await holder({ orderStatus: 'SENT', ticket: null });
    expect(fresh.id).not.toBe(decision.id);
    expect((await accountState.resolveSlotStates(accountId)).RETEST.occupied).toBe(true);
  });
});
