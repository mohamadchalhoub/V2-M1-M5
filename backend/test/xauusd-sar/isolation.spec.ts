/**
 * Engine A (xauusd-sar-v1) / Engine B (Telegram) coexistence — Part LVII.
 *
 * The account supports hedging, so both engines legitimately holding
 * opposite-direction XAUUSD exposure at once is normal, not a conflict.
 * Every test here asserts a negative: that a SAR operation — session init,
 * reversal, or daily close — never reads, writes, cancels or otherwise
 * touches anything that belongs to Engine B, and vice versa.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SarExecutionService, type SarBrokerPort, type SarSubmitRequest, type SarSubmitResponse } from '../../src/xauusd-sar/execution.service';
import { setSarVolume } from '../../src/xauusd-sar/volume-setting';
import { TELEGRAM_MAGIC } from '../../src/telegram-engine/safety-constants';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';
import { SAR_MAGIC } from '../../src/xauusd-sar/safety-constants';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
let accountId: string;
const SESSION_START = Date.UTC(2026, 8, 23, 22, 0); // 01:00 Beirut

class FilledBroker implements SarBrokerPort {
  private ticketSeq = 950000;
  async submit(request: SarSubmitRequest): Promise<SarSubmitResponse> {
    this.ticketSeq += 1;
    return { status: 'FILLED', ticket: String(this.ticketSeq), fillPrice: request.direction === 'BUY' ? 4500.5 : 4499.5 };
  }
}

function sarService() {
  return new SarExecutionService(prisma as never, new FilledBroker());
}

/** A Telegram (Engine B) signal + leg, created directly, exactly as Engine B's execution.service.ts would leave one mid-flight. */
async function createEngineBOpenPosition() {
  const signal = await prisma.telegramSignal.create({
    data: {
      engineVersion: 'telegram-sfxauusd1-copy-v1',
      accountId,
      symbol: 'XAUUSD',
      channelId: '-100123',
      messageId: '1',
      sourceKey: '-100123:1',
      semanticKey: 'k1',
      publishedAt: new Date(SESSION_START),
      receivedAt: new Date(SESSION_START),
      rawText: 'Gold buy now 4500\nSL 4490\nTP 4510',
      direction: 'BUY',
      entry: 4500,
      stopLoss: 4490,
      takeProfits: [4510],
      outcome: 'SUBMITTED',
      detail: 'filled',
      tp1: 4510,
      evidence: {},
    },
  });
  const leg = await prisma.telegramSignalLeg.create({
    data: {
      signalId: signal.id,
      idempotencyTag: 'TGISOLATION1',
      legIndex: 1,
      direction: 'BUY',
      volumeLots: 0.01,
      sourceEntry: 4500,
      stopLoss: 4490,
      takeProfit: 4510,
      magicNumber: TELEGRAM_MAGIC,
      orderStatus: 'FILLED',
      ticket: BigInt(800001),
    },
  });
  return { signal, leg };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  accountId = (await createTradingAccount(prisma, user.id)).id;
  await prisma.symbolMetadata.upsert({
    where: { symbol: 'XAUUSD' },
    create: { symbol: 'XAUUSD', point: 0.01, volumeMin: 0.01, volumeMax: 5, volumeStep: 0.01, contractSize: 100, digits: 2, profitCurrency: 'USD' },
    update: {},
  });
  await setSarVolume(prisma, { accountId, lots: 0.5, changedBy: 'test' });
  process.env.XAUUSD_SAR_ENABLED = 'true';
  process.env.XAUUSD_SAR_EXECUTION_MODE = 'DEMO';
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('magic numbers are disjoint across every engine', () => {
  it('SAR, RSI M1, RSI M5 and Telegram never collide', () => {
    const magics = [SAR_MAGIC, V2_MAGIC_M1, V2_MAGIC_M5, TELEGRAM_MAGIC];
    expect(new Set(magics).size).toBe(magics.length);
  });
});

describe('Engine B is untouched by every SAR operation', () => {
  it('a SAR reversal leaves an open Engine B position completely unchanged', async () => {
    const { leg: before } = await createEngineBOpenPosition();

    const svc = sarService();
    await svc.ensureSession(accountId, SESSION_START);
    await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);
    await svc.evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, SESSION_START + 1000);
    await svc.evaluateTick(accountId, { bid: 4503.0, ask: 4503.2, ageSeconds: 1, fresh: true }, SESSION_START + 2000);
    await svc.evaluateTick(accountId, { bid: 4502.5, ask: 4502.7, ageSeconds: 1, fresh: true }, SESSION_START + 3000); // reversal

    const after = await prisma.telegramSignalLeg.findUnique({ where: { id: before.id } });
    expect(after).toEqual(before);
  });

  it('the SAR daily close leaves an open Engine B position, and its group lock, completely unchanged', async () => {
    const { leg: before } = await createEngineBOpenPosition();
    await prisma.telegramSignalGroupLock.create({
      data: { accountId, signalId: before.signalId, state: 'FILLED' },
    });
    const lockBefore = await prisma.telegramSignalGroupLock.findUnique({ where: { accountId } });

    const svc = sarService();
    await svc.ensureSession(accountId, SESSION_START);
    await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);
    await svc.evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, SESSION_START + 1000);
    await svc.closeForDay(accountId, Date.UTC(2026, 8, 23, 20, 40));

    const legAfter = await prisma.telegramSignalLeg.findUnique({ where: { id: before.id } });
    const lockAfter = await prisma.telegramSignalGroupLock.findUnique({ where: { accountId } });
    expect(legAfter).toEqual(before);
    expect(lockAfter).toEqual(lockBefore);
  });

  it('a signal AWAITING_ENTRY_RETRACE is untouched by SAR session init or reversal', async () => {
    const parked = await prisma.telegramSignal.create({
      data: {
        engineVersion: 'telegram-sfxauusd1-copy-v1',
        accountId,
        symbol: 'XAUUSD',
        channelId: '-100123',
        messageId: '2',
        sourceKey: '-100123:2',
        semanticKey: 'k2',
        publishedAt: new Date(SESSION_START),
        receivedAt: new Date(SESSION_START),
        rawText: 'Gold buy now 4306\nSL 4295\nTP 4315',
        direction: 'BUY',
        entry: 4306,
        stopLoss: 4295,
        takeProfits: [4315],
        outcome: 'TELEGRAM_AWAITING_ENTRY_RETRACE',
        detail: 'parked',
        tp1: 4315,
        evidence: {},
      },
    });

    const svc = sarService();
    await svc.ensureSession(accountId, SESSION_START);
    await svc.initializeSession(accountId, { bid: 4500, ask: 4500.2, ageSeconds: 1, fresh: true }, SESSION_START);
    await svc.evaluateTick(accountId, { bid: 4500.4, ask: 4500.6, ageSeconds: 1, fresh: true }, SESSION_START + 1000);

    const after = await prisma.telegramSignal.findUnique({ where: { id: parked.id } });
    expect(after!.outcome).toBe('TELEGRAM_AWAITING_ENTRY_RETRACE');
    expect(Number(after!.entry)).toBe(4306);
  });
});

describe('SAR reconciliation never treats a foreign magic as its own', () => {
  it('isOwnedBySar is false for Engine B, legacy M1, and legacy M5 magics', async () => {
    const { isOwnedBySar } = await import('../../src/xauusd-sar/ownership');
    expect(isOwnedBySar(TELEGRAM_MAGIC)).toBe(false);
    expect(isOwnedBySar(V2_MAGIC_M1)).toBe(false);
    expect(isOwnedBySar(V2_MAGIC_M5)).toBe(false);
    expect(isOwnedBySar(SAR_MAGIC)).toBe(true);
  });
});
