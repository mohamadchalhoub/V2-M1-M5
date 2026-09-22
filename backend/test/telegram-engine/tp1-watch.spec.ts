/**
 * The TP1 watcher against a real database and real quote rows.
 *
 * The scenario that justifies the whole component: price trades through the
 * first target and comes straight back. A check made only when a leg is
 * evaluated would see the retraced price and open the trade; the latch,
 * written the moment the touch happened, does not.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TelegramTp1WatchService } from '../../src/telegram-engine/tp1-watch.service';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const watcher = new TelegramTp1WatchService(prisma);

const NOW = Date.UTC(2026, 8, 23, 13, 0, 0);
let accountId: string;

/** The collector's live tick row, which is where the watcher reads price. */
async function setQuote(bid: number, ask: number, atMs = NOW - 200) {
  await prisma.liveTick.upsert({
    where: { symbol: 'XAUUSD' },
    create: { symbol: 'XAUUSD', bid, ask, tickAt: new Date(atMs) },
    update: { bid, ask, tickAt: new Date(atMs) },
  });
}

async function signal(direction: 'BUY' | 'SELL', tp1: number, publishedAtMs = NOW - 5_000) {
  return prisma.telegramSignal.create({
    data: {
      engineVersion: 'telegram-sfxauusd1-copy-v1',
      accountId,
      channelId: '-1001234567890',
      messageId: `m-${Math.random().toString(36).slice(2)}`,
      sourceKey: `k-${Math.random().toString(36).slice(2)}`,
      semanticKey: `s-${Math.random().toString(36).slice(2)}`,
      publishedAt: new Date(publishedAtMs),
      receivedAt: new Date(publishedAtMs + 500),
      rawText: 'fixture',
      direction,
      entry: direction === 'SELL' ? 4338 : 4331,
      stopLoss: direction === 'SELL' ? 4348 : 4321,
      takeProfits: [tp1],
      tp1,
      outcome: 'SUBMITTED',
      detail: 'fixture',
      evidence: {},
    },
  });
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

describe('latching a touch', () => {
  it('does not latch while price is short of the target', async () => {
    const s = await signal('SELL', 4329);
    await setQuote(4334.7, 4335.0);

    const result = await watcher.sweep(accountId, NOW);
    expect(result.latched).toBe(0);
    const after = await prisma.telegramSignal.findUnique({ where: { id: s.id } });
    expect(after!.tp1Touched).toBe(false);
  });

  it('latches the moment the target is reached', async () => {
    const s = await signal('SELL', 4329);
    await setQuote(4328.7, 4329.0);

    const result = await watcher.sweep(accountId, NOW);
    expect(result.latched).toBe(1);
    const after = await prisma.telegramSignal.findUnique({ where: { id: s.id } });
    expect(after!.tp1Touched).toBe(true);
    expect(Number(after!.tp1TouchPrice)).toBe(4329);
    expect(after!.tp1TouchedAt).not.toBeNull();
  });

  it('stays latched after price retraces — the decisive case', async () => {
    const s = await signal('SELL', 4329);

    await setQuote(4328.7, 4329.0);
    await watcher.sweep(accountId, NOW);

    // Price comes back up to a level that, on its own, looks like a fine
    // entry for this signal.
    await setQuote(4333.7, 4334.0, NOW + 1_000);
    const second = await watcher.sweep(accountId, NOW + 1_000);

    expect(second.latched).toBe(0); // nothing new to latch
    const after = await prisma.telegramSignal.findUnique({ where: { id: s.id } });
    expect(after!.tp1Touched).toBe(true);
    expect(Number(after!.tp1TouchPrice)).toBe(4329);
  });

  it('records the FIRST touch instant, not the most recent', async () => {
    const s = await signal('SELL', 4329);
    await setQuote(4328.7, 4329.0);
    await watcher.sweep(accountId, NOW);
    const first = await prisma.telegramSignal.findUnique({ where: { id: s.id } });

    await setQuote(4320.0, 4320.3, NOW + 5_000);
    await watcher.sweep(accountId, NOW + 5_000);
    const second = await prisma.telegramSignal.findUnique({ where: { id: s.id } });

    expect(second!.tp1TouchedAt!.getTime()).toBe(first!.tp1TouchedAt!.getTime());
  });

  it('mirrors for a BUY, latching on the bid', async () => {
    const s = await signal('BUY', 4338);
    await setQuote(4338.0, 4338.3);

    await watcher.sweep(accountId, NOW);
    const after = await prisma.telegramSignal.findUnique({ where: { id: s.id } });
    expect(after!.tp1Touched).toBe(true);
  });

  it('uses the closing side: a SELL does not latch on the bid alone', async () => {
    const s = await signal('SELL', 4329);
    // Bid is through the target but the ask — which is what a short is
    // closed at — is not.
    await setQuote(4328.8, 4329.1);

    await watcher.sweep(accountId, NOW);
    const after = await prisma.telegramSignal.findUnique({ where: { id: s.id } });
    expect(after!.tp1Touched).toBe(false);
  });
});

describe('what the watcher does not do', () => {
  it('latches nothing when no usable quote exists', async () => {
    const s = await signal('SELL', 4329);
    // A tick far in the past is not a usable quote.
    await setQuote(4328.0, 4328.3, NOW - 10 * 60_000);

    const result = await watcher.sweep(accountId, NOW);
    expect(result.latched).toBe(0);
    const after = await prisma.telegramSignal.findUnique({ where: { id: s.id } });
    expect(after!.tp1Touched).toBe(false);
  });

  it('ignores signals older than the watch window', async () => {
    await signal('SELL', 4329, NOW - 60 * 60_000);
    await setQuote(4328.7, 4329.0);

    const result = await watcher.sweep(accountId, NOW);
    expect(result.examined).toBe(0);
  });

  it('never un-latches a signal', async () => {
    const s = await signal('SELL', 4329);
    await prisma.telegramSignal.update({
      where: { id: s.id },
      data: { tp1Touched: true, tp1TouchedAt: new Date(NOW - 1000), tp1TouchPrice: 4329 },
    });
    // Price nowhere near the target.
    await setQuote(4340.0, 4340.3);

    await watcher.sweep(accountId, NOW);
    const after = await prisma.telegramSignal.findUnique({ where: { id: s.id } });
    expect(after!.tp1Touched).toBe(true);
  });
});
