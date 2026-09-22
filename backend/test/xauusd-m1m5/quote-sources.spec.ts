/**
 * The two price streams, read from a real database.
 *
 * The case that matters is the one measured on the VPS: the one-second tick
 * stream stores BROKER wall-clock time labelled as UTC, so uncorrected every
 * tick read three hours in the future, was rejected by the quote resolver,
 * and the strategy silently fell back to a ~10-second live tick.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readQuoteCandidates } from '../../src/xauusd-m1m5/quote-sources';
import { resolveQuote } from '../../src/xauusd-m1m5/quote';
import { storedBrokerTimeToUtcMs } from '../../src/xauusd-m1m5/tick-time';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();

// 22 September is summer time in EET: broker wall clock = UTC + 3h.
const TRUE_UTC = Date.parse('2026-09-22T08:05:00Z');
const BROKER_WALL_AS_UTC = Date.parse('2026-09-22T11:05:00Z');

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('storedBrokerTimeToUtcMs', () => {
  it('turns the broker wall clock back into true UTC (summer, +3h)', () => {
    expect(storedBrokerTimeToUtcMs(BROKER_WALL_AS_UTC, 'EET')).toBe(TRUE_UTC);
  });

  it('uses the winter offset (+2h) in winter', () => {
    expect(storedBrokerTimeToUtcMs(Date.parse('2026-01-15T12:00:00Z'), 'EET')).toBe(Date.parse('2026-01-15T10:00:00Z'));
  });

  it('drops a wall-clock time that does not exist rather than guessing', () => {
    // EET springs forward 03:00 -> 04:00 on 2026-03-29; 03:30 never happens.
    expect(storedBrokerTimeToUtcMs(Date.parse('2026-03-29T03:30:00Z'), 'EET')).toBeNull();
  });
});

describe('readQuoteCandidates', () => {
  it('corrects a historical tick onto the true-UTC timeline', async () => {
    await prisma.historicalTick.create({
      data: {
        symbol: 'XAUUSD',
        timestamp: new Date(BROKER_WALL_AS_UTC),
        bid: 4302.7,
        ask: 4303.1,
        source: 'collector_live_sync',
        flags: 6,
        batchSeq: 0,
      },
    });

    const [historical] = await readQuoteCandidates(prisma);

    expect(historical?.source).toBe('historical_ticks');
    expect(historical?.tickAtMs).toBe(TRUE_UTC);
  });

  it('leaves the live tick alone, since that path is already true UTC', async () => {
    await prisma.liveTick.create({
      data: { symbol: 'XAUUSD', bid: 4302.7, ask: 4303.1, tickAt: new Date(TRUE_UTC) },
    });

    const [live] = await readQuoteCandidates(prisma);

    expect(live?.source).toBe('live_ticks');
    expect(live?.tickAtMs).toBe(TRUE_UTC);
  });

  it('lets the fresher one-second stream WIN over the older live tick', async () => {
    // The whole point of the fix. Before it, the historical tick read three
    // hours ahead, was rejected, and the 23s-old live tick was used instead.
    await prisma.liveTick.create({
      data: { symbol: 'XAUUSD', bid: 4300.0, ask: 4300.4, tickAt: new Date(TRUE_UTC - 23_000) },
    });
    await prisma.historicalTick.create({
      data: {
        symbol: 'XAUUSD',
        timestamp: new Date(BROKER_WALL_AS_UTC - 1_000),
        bid: 4302.7,
        ask: 4303.1,
        source: 'collector_live_sync',
        flags: 6,
        batchSeq: 0,
      },
    });

    const candidates = await readQuoteCandidates(prisma);
    const resolved = resolveQuote(candidates, TRUE_UTC);

    expect(resolved.quote?.source).toBe('historical_ticks');
    expect(resolved.quote?.bid).toBe(4302.7);
  });
});
