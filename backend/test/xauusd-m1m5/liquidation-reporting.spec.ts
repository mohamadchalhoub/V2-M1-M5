/**
 * §15.5/§15.7 — Friday liquidation and 24-hour reporting, against a
 * simulated broker and a real database.
 *
 * Two properties dominate, and both are about refusing to overstate:
 *
 * - liquidation never reports flat from what it SENT, only from what the
 *   broker subsequently shows;
 * - reporting can fail to deliver without that failure touching trading.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  M1M5LiquidationService,
  type LiquidationBrokerPort,
} from '../../src/xauusd-m1m5/liquidation.service';
import { M1M5ReportingService, type ReportDeliveryPort } from '../../src/xauusd-m1m5/reporting.service';
import type { BrokerItem, LiquidationTarget } from '../../src/xauusd-m1m5/liquidation';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';
import { REPORT_PERIOD_MS } from '../../src/xauusd-m1m5/reporting';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION, type Timeframe } from '../../src/xauusd-m1m5/spec';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();

/** Friday 2026-09-25 23:10 Beirut — after the 23:00 cutoff, before 23:30. */
const FRIDAY_AFTER_CUTOFF = Date.UTC(2026, 8, 25, 20, 10, 0);
/** Friday 23:45 Beirut — past the deadline. */
const FRIDAY_PAST_DEADLINE = Date.UTC(2026, 8, 25, 20, 45, 0);
/** Wednesday 10:00 Beirut — liquidation not due. */
const WEDNESDAY = Date.UTC(2026, 8, 23, 7, 0, 0);

const OTHER_BOT_MAGIC = 262610190;

let accountId: string;
let seq = 0;

function item(over: Partial<BrokerItem> & { ticket: string }): BrokerItem {
  return { kind: 'POSITION', symbol: 'XAUUSD', magicNumber: V2_MAGIC_M1, volume: 0.5, ...over };
}

class FakeBroker implements LiquidationBrokerPort {
  public closed: string[] = [];
  public cancelled: string[] = [];
  constructor(private snapshots: Array<readonly BrokerItem[] | null>) {}
  async snapshot() {
    return this.snapshots.length > 1 ? (this.snapshots.shift() as readonly BrokerItem[] | null) : this.snapshots[0];
  }
  async close(t: LiquidationTarget) {
    this.closed.push(t.ticket);
    return { accepted: true };
  }
  async cancel(t: LiquidationTarget) {
    this.cancelled.push(t.ticket);
    return { accepted: true };
  }
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  const account = await createTradingAccount(prisma, user.id);
  accountId = account.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('§9.3 liquidation scope', () => {
  it('is not due outside the Friday window', async () => {
    const broker = new FakeBroker([[item({ ticket: 'x' })]]);
    const result = await new M1M5LiquidationService(prisma, broker).runOnce(WEDNESDAY);
    expect(result.verdict.status).toBe('NOT_DUE');
    expect(broker.closed).toEqual([]);
  });

  it('closes our positions and leaves every foreign one alone', async () => {
    const open = [
      item({ ticket: 'ours-m1', magicNumber: V2_MAGIC_M1 }),
      item({ ticket: 'ours-m5', magicNumber: V2_MAGIC_M5 }),
      item({ ticket: 'theirs', magicNumber: OTHER_BOT_MAGIC }),
      item({ ticket: 'manual', magicNumber: null }),
    ];
    // Second snapshot: ours gone, foreign still open.
    const after = [item({ ticket: 'theirs', magicNumber: OTHER_BOT_MAGIC }), item({ ticket: 'manual', magicNumber: null })];
    const broker = new FakeBroker([open, after]);

    const result = await new M1M5LiquidationService(prisma, broker).runOnce(FRIDAY_AFTER_CUTOFF);

    expect(broker.closed.sort()).toEqual(['ours-m1', 'ours-m5']);
    expect(broker.closed).not.toContain('theirs');
    expect(broker.closed).not.toContain('manual');
    expect(result.excluded.map((e) => e.ticket).sort()).toEqual(['manual', 'theirs']);
    // Flat means OUR exposure is zero; foreign positions still being open
    // does not stop that.
    expect(result.verdict.status).toBe('CONFIRMED_FLAT');
  });

  it('cancels pending orders before closing positions', async () => {
    const open = [
      item({ ticket: 'pos', kind: 'POSITION', magicNumber: V2_MAGIC_M1 }),
      item({ ticket: 'ord', kind: 'PENDING_ORDER', magicNumber: V2_MAGIC_M5 }),
    ];
    const broker = new FakeBroker([open, []]);
    await new M1M5LiquidationService(prisma, broker).runOnce(FRIDAY_AFTER_CUTOFF);

    expect(broker.cancelled).toEqual(['ord']);
    expect(broker.closed).toEqual(['pos']);
  });
});

describe('§9.3 a sent request is not a closure', () => {
  it('does not report flat while our positions are still open after the attempt', async () => {
    const open = [item({ ticket: 'stubborn', magicNumber: V2_MAGIC_M1 })];
    // The close is accepted, but the position is STILL THERE on re-query.
    const broker = new FakeBroker([open, open]);

    const result = await new M1M5LiquidationService(prisma, broker).runOnce(FRIDAY_AFTER_CUTOFF);

    expect(broker.closed).toEqual(['stubborn']);
    expect(result.verdict.status).not.toBe('CONFIRMED_FLAT');
    expect(result.verdict.remainingOwned).toBe(1);
  });

  it('never reports flat when broker state cannot be read', async () => {
    const broker = new FakeBroker([null]);
    const result = await new M1M5LiquidationService(prisma, broker).runOnce(FRIDAY_AFTER_CUTOFF);
    expect(result.verdict.status).toBe('IN_PROGRESS');
    expect(result.verdict.detail).toMatch(/never reported as flat/i);
  });

  it('reports a missed deadline with only our exposure named', async () => {
    const open = [
      item({ ticket: 'ours', magicNumber: V2_MAGIC_M1 }),
      item({ ticket: 'theirs', magicNumber: OTHER_BOT_MAGIC }),
    ];
    const broker = new FakeBroker([open, open]);
    const result = await new M1M5LiquidationService(prisma, broker).runOnce(FRIDAY_PAST_DEADLINE);

    expect(result.verdict.status).toBe('DEADLINE_MISSED');
    expect(result.verdict.detail).toContain('ours');
    expect(result.verdict.detail).not.toContain('theirs');
  });
});

describe('§9.3 entries stay blocked while liquidation is unresolved', () => {
  const svc = () => new M1M5LiquidationService(prisma, new FakeBroker([[]]));

  it('blocks on anything but confirmed flat or not due', () => {
    const s = svc();
    expect(s.entriesBlockedByLiquidation({ status: 'NOT_DUE', remainingOwned: 0, detail: '' })).toBeNull();
    expect(s.entriesBlockedByLiquidation({ status: 'CONFIRMED_FLAT', remainingOwned: 0, detail: '' })).toBeNull();
    expect(s.entriesBlockedByLiquidation({ status: 'IN_PROGRESS', remainingOwned: 1, detail: 'x' })).toContain(
      'unresolved',
    );
    expect(s.entriesBlockedByLiquidation({ status: 'DEADLINE_MISSED', remainingOwned: 1, detail: 'x' })).toContain(
      'unresolved',
    );
  });
});

// ---------------------------------------------------------------------------

class FakeDelivery implements ReportDeliveryPort {
  public sent: string[] = [];
  constructor(private readonly fail = false) {}
  async send(text: string) {
    if (this.fail) throw new Error('telegram unreachable');
    this.sent.push(text);
  }
}

const START = Date.UTC(2026, 8, 20, 0, 0, 0);

async function closedPosition(timeframe: Timeframe, netRealized: number, filledAtMs: number) {
  seq += 1;
  return prisma.xauusdM1M5Decision.create({
    data: {
      strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
      specHash: SPEC_HASH,
      accountId,
      timeframe,
      direction: netRealized >= 0 ? 'SELL' : 'BUY',
      observedAt: new Date(filledAtMs - 1000),
      eventId: `evt-r-${seq}`,
      rsiValue: 92,
      threshold: 91,
      basisPrice: 4450,
      observationMode: 'TICK',
      reasoning: 'test',
      evidence: {},
      orderStatus: 'FILLED',
      filledAt: new Date(filledAtMs),
      // The service reads netRealized from fillPrice in this build.
      fillPrice: netRealized,
      ticket: BigInt(900000 + seq),
      magicNumber: timeframe === 'M1' ? V2_MAGIC_M1 : V2_MAGIC_M5,
    },
  });
}

describe('§13.1 the 24-hour report', () => {
  it('reports nothing before a period is complete', async () => {
    await closedPosition('M1', 5, START + 1000);
    const svc = new M1M5ReportingService(prisma, new FakeDelivery());
    const result = await svc.runOnce(accountId, 'DEMO test', START + 1000);
    expect(result.generated).toBe(false);
    expect(result.detail).toMatch(/No complete reporting period/i);
  });

  it('generates and delivers once the period completes', async () => {
    await closedPosition('M1', 5, START);
    await closedPosition('M1', -2, START + 3600_000);
    await closedPosition('M5', 7, START + 7200_000);

    const delivery = new FakeDelivery();
    const result = await new M1M5ReportingService(prisma, delivery).runOnce(
      accountId,
      'DEMO test',
      START + REPORT_PERIOD_MS + 1000,
    );

    expect(result.generated).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.report?.byTimeframe.M1).toMatchObject({ wins: 1, losses: 1 });
    expect(result.report?.byTimeframe.M5).toMatchObject({ wins: 1, losses: 0 });
    expect(delivery.sent[0]).toMatch(/M1: 1 win, 1 loss/);
    expect(delivery.sent[0]).toMatch(/Combined: 2 wins, 1 loss/);
  });

  it('cannot generate the same period twice', async () => {
    await closedPosition('M1', 5, START);
    const nowMs = START + REPORT_PERIOD_MS + 1000;

    const first = await new M1M5ReportingService(prisma, new FakeDelivery()).runOnce(accountId, 'DEMO', nowMs);
    expect(first.generated).toBe(true);

    // A second worker, or the same one after a restart.
    const second = await new M1M5ReportingService(prisma, new FakeDelivery()).runOnce(accountId, 'DEMO', nowMs);
    expect(second.generated).toBe(false);
    expect(await prisma.xauusdM1M5ReportPeriod.count()).toBe(1);
  });

  it('records the period even when delivery fails, and does not throw', async () => {
    await closedPosition('M1', -3, START);

    const result = await new M1M5ReportingService(prisma, new FakeDelivery(true)).runOnce(
      accountId,
      'DEMO',
      START + REPORT_PERIOD_MS + 1000,
    );

    // Generated, not delivered, and no exception escaped into the caller --
    // which is what keeps a Telegram outage away from trading.
    expect(result.generated).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.detail).toMatch(/trading is unaffected/i);

    const row = await prisma.xauusdM1M5ReportPeriod.findFirst({ where: { accountId } });
    expect(row?.deliveredAt).toBeNull();
    expect(row?.deliveryError).toContain('telegram unreachable');
    expect(row?.m1Losses).toBe(1);
  });

  it('persists the included position identities', async () => {
    const a = await closedPosition('M1', 4, START);
    await new M1M5ReportingService(prisma, new FakeDelivery()).runOnce(
      accountId,
      'DEMO',
      START + REPORT_PERIOD_MS + 1000,
    );
    const row = await prisma.xauusdM1M5ReportPeriod.findFirst({ where: { accountId } });
    expect(row?.includedPositionIds).toContain(String(a.ticket));
  });

  it('excludes closures outside the interval', async () => {
    await closedPosition('M1', 5, START);
    await closedPosition('M1', 9, START + REPORT_PERIOD_MS + 60_000); // next period

    const result = await new M1M5ReportingService(prisma, new FakeDelivery()).runOnce(
      accountId,
      'DEMO',
      START + REPORT_PERIOD_MS + 1000,
    );
    expect(result.report?.byTimeframe.M1.wins).toBe(1);
  });
});
