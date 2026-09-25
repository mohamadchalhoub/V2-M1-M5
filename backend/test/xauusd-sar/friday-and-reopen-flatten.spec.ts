import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFlattenIdentity, closeWindowAction, readFlattenRequired, type BrokerSarPosition } from '../../src/xauusd-sar/flatten-required';
import { SarExecutionService, type SarBrokerPort, type SarSubmitRequest, type SarSubmitResponse } from '../../src/xauusd-sar/execution.service';
import { SAR_MAGIC } from '../../src/xauusd-sar/safety-constants';
import { isWithinDailyClose } from '../../src/xauusd-sar/spec';
import { setSarVolume } from '../../src/xauusd-sar/volume-setting';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

// Friday 2026-09-25 and Monday 2026-09-28 are UTC+3 in Beirut.
const fri = (h: number, m: number) => Date.UTC(2026, 8, 25, h - 3, m);
const mon = (h: number, m: number) => Date.UTC(2026, 8, 28, h - 3, m);
const thu = (h: number, m: number) => Date.UTC(2026, 8, 24, h - 3, m);

describe('Friday and weekend close', () => {
  it('Friday trades until 22:29 and is closed from 22:30 Beirut (broker stops XAUUSD at 23:00)', () => {
    expect(isWithinDailyClose(fri(22, 29))).toBe(false);
    expect(isWithinDailyClose(fri(22, 30))).toBe(true);
    expect(isWithinDailyClose(fri(22, 59))).toBe(true);
  });

  it('a Friday position cannot be held through the broker close: 22:30–23:00 is inside the close window', () => {
    for (const m of [30, 40, 50, 59]) expect(isWithinDailyClose(fri(22, m))).toBe(true);
  });

  it('Saturday and Sunday are closed all day', () => {
    expect(isWithinDailyClose(Date.UTC(2026, 8, 26, 12, 0))).toBe(true);
    expect(isWithinDailyClose(Date.UTC(2026, 8, 27, 20, 0))).toBe(true);
  });

  it('weekdays are unchanged: 01:00–23:40 Beirut trading, closed outside', () => {
    expect(isWithinDailyClose(thu(22, 30))).toBe(false);
    expect(isWithinDailyClose(thu(23, 39))).toBe(false);
    expect(isWithinDailyClose(thu(23, 40))).toBe(true);
    expect(isWithinDailyClose(mon(0, 59))).toBe(true);
    expect(isWithinDailyClose(mon(1, 0))).toBe(false);
  });

  it('follows Beirut DST (winter Friday, UTC+2): closed from 20:30 UTC', () => {
    expect(isWithinDailyClose(Date.UTC(2026, 11, 11, 20, 29))).toBe(false);
    expect(isWithinDailyClose(Date.UTC(2026, 11, 11, 20, 30))).toBe(true);
  });
});

const EXPECTED = { ticket: '58640000369', side: 'BUY' as const, volume: 0.01, reason: 'stranded over weekend' };
const POS: BrokerSarPosition = { ticket: '58640000369', side: 'BUY', volume: 0.01, magic: SAR_MAGIC, symbol: 'XAUUSD' };

describe('stranded-position identity', () => {
  it('confirms the exact ticket, side, volume, magic and sole SAR position', () => {
    expect(checkFlattenIdentity(EXPECTED, [POS], '58640000369')).toEqual([]);
  });

  it.each<[string, readonly BrokerSarPosition[], string | null]>([
    ['a different ticket', [{ ...POS, ticket: '1' }], '58640000369'],
    ['a SELL instead of a BUY', [{ ...POS, side: 'SELL' }], '58640000369'],
    ['a different volume', [{ ...POS, volume: 0.02 }], '58640000369'],
    ['a second SAR position', [POS, { ...POS, ticket: '2' }], '58640000369'],
    ['no SAR position at all', [], '58640000369'],
    ['a session owning another ticket', [POS], '99'],
  ])('refuses with %s', (_l, positions, sessionTicket) => {
    expect(checkFlattenIdentity(EXPECTED, positions, sessionTicket).length).toBeGreaterThan(0);
  });
});

describe('what the scheduler may do while closed or while a flatten is required', () => {
  it('waits, submitting nothing, while the market is closed — the requirement stays pending', () => {
    expect(closeWindowAction({ sessionState: 'ACTIVE_BUY', marketTradeable: false, flattenRequired: true, identityProblems: [] })).toBe('WAIT_FOR_TRADEABLE_MARKET');
    expect(closeWindowAction({ sessionState: 'ACTIVE_BUY', marketTradeable: false, flattenRequired: false, identityProblems: [] })).toBe('WAIT_FOR_TRADEABLE_MARKET');
  });

  it('flattens once the market is tradeable and the identity matches', () => {
    expect(closeWindowAction({ sessionState: 'ACTIVE_BUY', marketTradeable: true, flattenRequired: true, identityProblems: [] })).toBe('FLATTEN');
  });

  it('refuses to trade on an identity mismatch', () => {
    expect(closeWindowAction({ sessionState: 'ACTIVE_BUY', marketTradeable: true, flattenRequired: true, identityProblems: ['x'] })).toBe('IDENTITY_MISMATCH');
  });

  it('does nothing further once the session is closed (no automatic new exposure)', () => {
    expect(closeWindowAction({ sessionState: 'DAILY_CLOSED', marketTradeable: true, flattenRequired: true, identityProblems: [] })).toBe('NONE');
  });
});

describe('the flatten-required marker takes precedence over the strategy', () => {
  const prisma = new PrismaClient();
  let accountId: string;
  let dir: string;
  const START = Date.UTC(2026, 8, 28, 22, 0); // Monday 01:00 Beirut

  class Broker implements SarBrokerPort {
    public readonly calls: SarSubmitRequest[] = [];
    async submit(r: SarSubmitRequest): Promise<SarSubmitResponse> {
      this.calls.push(r);
      return { status: 'FILLED', ticket: String(900000 + this.calls.length), fillPrice: r.direction === 'BUY' ? 4291.61 : 4291.1 };
    }
  }

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await createUser(prisma);
    accountId = (await createTradingAccount(prisma, user.id)).id;
    await prisma.symbolMetadata.create({
      data: { symbol: 'XAUUSD', point: 0.01, volumeMin: 0.01, volumeMax: 5, volumeStep: 0.01, contractSize: 100, tradeMode: 4, digits: 2, profitCurrency: 'USD' },
    });
    await setSarVolume(prisma, { accountId, lots: 0.01, changedBy: 'test' });
    process.env.XAUUSD_SAR_ENABLED = 'true';
    process.env.XAUUSD_SAR_EXECUTION_MODE = 'DEMO';
    dir = mkdtempSync(join(tmpdir(), 'sar-flat-'));
    process.env.XAUUSD_SAR_FLATTEN_REQUIRED_PATH = join(dir, 'FLAT');
  });

  afterEach(() => {
    delete process.env.XAUUSD_SAR_FLATTEN_REQUIRED_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function activeBuy(svc: SarExecutionService) {
    await svc.ensureSession(accountId, START);
    await svc.initializeSession(accountId, { bid: 4291.0, ask: 4291.2, ageSeconds: 1, fresh: true }, START);
    await svc.evaluateTick(accountId, { bid: 4291.5, ask: 4291.7, ageSeconds: 1, fresh: true }, START + 1_000);
    expect((await prisma.xauusdSarSession.findUnique({ where: { accountId } }))!.state).toBe('ACTIVE_BUY');
  }

  it('a gap below the reversal level does NOT reverse while the marker is present', async () => {
    const broker = new Broker();
    const svc = new SarExecutionService(prisma as never, broker);
    await activeBuy(svc);
    writeFileSync(process.env.XAUUSD_SAR_FLATTEN_REQUIRED_PATH!, JSON.stringify(EXPECTED));
    const before = broker.calls.length;

    const r = await svc.evaluateTick(accountId, { bid: 4285.0, ask: 4285.3, ageSeconds: 1, fresh: true }, START + 60_000);

    expect(r.action).toBe('BLOCKED');
    expect(broker.calls.length).toBe(before);
    expect((await prisma.xauusdSarSession.findUnique({ where: { accountId } }))!.state).toBe('ACTIVE_BUY');
  });

  it('the watchdog path cannot reverse either', async () => {
    const broker = new Broker();
    const svc = new SarExecutionService(prisma as never, broker);
    await activeBuy(svc);
    writeFileSync(process.env.XAUUSD_SAR_FLATTEN_REQUIRED_PATH!, JSON.stringify(EXPECTED));
    await prisma.xauusdSarSession.update({ where: { accountId }, data: { lastEvaluatedAt: new Date(START - 3_600_000) } });
    const before = broker.calls.length;

    await svc.watchdogCheck(accountId, { bid: 4285.0, ask: 4285.3, ageSeconds: 1, fresh: true }, START + 60_000);

    expect(broker.calls.length).toBe(before);
  });

  it('the flatten closes only: a FLATTEN, never a REVERSAL or an opposite open', async () => {
    const broker = new Broker();
    const svc = new SarExecutionService(prisma as never, broker);
    await activeBuy(svc);
    writeFileSync(process.env.XAUUSD_SAR_FLATTEN_REQUIRED_PATH!, JSON.stringify(EXPECTED));
    const before = broker.calls.length;

    await svc.closeForDay(accountId, START + 60_000);

    const sent = broker.calls.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('FLATTEN');
    expect((await prisma.xauusdSarSession.findUnique({ where: { accountId } }))!.state).toBe('DAILY_CLOSE_PENDING_CONFIRMATION');
  });

  it('an unreadable marker still counts as required (never silently absent)', () => {
    writeFileSync(process.env.XAUUSD_SAR_FLATTEN_REQUIRED_PATH!, 'not json');
    expect(readFlattenRequired()).toBe('UNREADABLE');
  });
});
