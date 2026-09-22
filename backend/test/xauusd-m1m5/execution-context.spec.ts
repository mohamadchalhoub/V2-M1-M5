/**
 * Assembling the numbers the risk gate judges.
 *
 * The gates in `execution.service` are pure functions, tested exhaustively
 * elsewhere. This file tests the other half of the problem, which is where the
 * numbers they judge come from — and specifically the rule that governs it:
 * **a value that could not be established is never replaced by a plausible
 * one.**
 *
 * That rule is what these tests are for. A gate given an invented number
 * approves confidently and wrongly, and does so silently, which is worse than
 * a gate that refuses.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildExecutionContext,
  marginRequiredFor,
  stopRiskForLots,
} from '../../src/xauusd-m1m5/execution-context';
import type { CrossingSignal } from '../../src/xauusd-m1m5/crossing';
import { V2_MAGIC_M1, V2_SL_USD, V2_SYMBOL } from '../../src/xauusd-m1m5/safety-constants';
import { SPEC_HASH, XAUUSD_M1M5_STRATEGY_VERSION } from '../../src/xauusd-m1m5/spec';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();

let accountId: string;
const NOW = Date.parse('2026-09-22T09:00:00Z');

const SIGNAL: CrossingSignal = {
  signalId: 'evt-1',
  timeframe: 'M1',
  direction: 'SELL',
  rsi: 92,
  previousRsi: 90,
  threshold: 91,
  price: 4360,
  observedAt: NOW - 500,
};

const QUOTE = { bid: 4360, ask: 4360.5, tickAtMs: NOW - 500 };

/** The verified live values from the broker, so the tests mirror production. */
async function seedSymbol(over: Record<string, unknown> = {}) {
  await prisma.symbolMetadata.create({
    data: {
      symbol: V2_SYMBOL,
      volumeMin: 0.01,
      volumeMax: 100,
      volumeStep: 0.01,
      digits: 2,
      point: 0.01,
      contractSize: 100,
      profitCurrency: 'USD',
      tradeStopsLevel: 0,
      tradeFreezeLevel: 0,
      ...over,
    },
  });
}

async function seedAccountSnapshot(ageMs = 1_000, equity = 3000) {
  await prisma.accountSnapshot.create({
    data: {
      accountId,
      balance: equity,
      equity,
      margin: 0,
      freeMargin: equity,
      profit: 0,
      capturedAt: new Date(NOW - ageMs),
    },
  });
}

function snapshot(leverage: number | null) {
  return {
    sessionOpen: true,
    leverage,
    permissions: {
      capturedAtMs: NOW - 1000,
      loginId: '5056294252',
      tradeMode: 'DEMO' as const,
      terminalConnected: true,
      terminalTradeAllowed: true,
      terminalTradeApiDisabled: false,
      accountTradeAllowed: true,
      accountTradeExpert: true,
      marginMode: 'RETAIL_HEDGING' as const,
    },
  };
}

function build(over: Partial<Parameters<typeof buildExecutionContext>[0]> = {}) {
  return buildExecutionContext({
    prisma,
    accountId,
    signal: SIGNAL,
    nowMs: NOW,
    quote: QUOTE,
    snapshot: snapshot(100),
    expectedLoginId: '5056294252',
    scheduleAllowsEntries: true,
    scheduleDetail: 'eligible',
    ...over,
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

describe('the arithmetic', () => {
  it('prices a $5.00 stop from the contract size', () => {
    // Gold is quoted per ounce and a standard lot is 100 ounces, so a $5.00
    // adverse move on 0.5 lots costs $250.
    expect(stopRiskForLots(0.5, 100)).toBe(V2_SL_USD * 100 * 0.5);
    expect(stopRiskForLots(0.5, 100)).toBe(250);
  });

  it('computes margin from MT5’s own formula', () => {
    // 0.5 lots * 100 oz * 4360 / 100 leverage
    expect(marginRequiredFor(0.5, 100, 4360, 100)).toBeCloseTo(2180, 6);
  });

  it('returns Infinity when leverage is unknown, so the margin check refuses', () => {
    // Not a sentinel to special-case later: it flows into the comparison and
    // is refused there, which is the correct outcome and the correct place.
    expect(marginRequiredFor(0.5, 100, 4360, null)).toBe(Number.POSITIVE_INFINITY);
    expect(marginRequiredFor(0.5, 100, 4360, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('every unknown blocks', () => {
  it('reports a missing symbol row rather than assuming the point size', async () => {
    await seedAccountSnapshot();

    const { context, gaps } = await build();

    expect(gaps.blocking.join(' ')).toContain('SymbolMetadata');
    // Zero, not the expected constant. `bracketsFor` compares the live value
    // against the expectation precisely so a wrong one is caught.
    expect(context.constraints.pointSize).toBe(0);
  });

  it('reports a missing account snapshot and leaves equity null', async () => {
    await seedSymbol();

    const { context, gaps } = await build();

    expect(gaps.blocking.join(' ')).toContain('no account snapshot');
    // Null, never 0: the risk gate blocks on null and would happily divide by
    // a zero equity into meaningless percentages.
    expect(context.account.equity).toBeNull();
    expect(context.account.freeMargin).toBeNull();
  });

  it('reports unknown leverage and makes the margin unaffordable', async () => {
    await seedSymbol();
    await seedAccountSnapshot();

    const { context, gaps } = await build({ snapshot: snapshot(null) });

    expect(gaps.blocking.join(' ')).toContain('leverage');
    expect(context.marginRequired).toBe(Number.POSITIVE_INFINITY);
  });

  it('passes a null MT5 snapshot straight through as null', async () => {
    await seedSymbol();
    await seedAccountSnapshot();

    const { context } = await build({ snapshot: null });

    // evaluateReadiness turns this into NO_SNAPSHOT. Synthesising a permissive
    // default here would defeat the only check that establishes the terminal
    // may trade at all.
    expect(context.mt5Snapshot).toBeNull();
  });
});

describe('with everything known', () => {
  it('builds a context with no blocking gaps', async () => {
    await seedSymbol();
    await seedAccountSnapshot();

    const { context, gaps } = await build();

    expect(gaps.blocking).toEqual([]);
    expect(context.constraints.pointSize).toBe(0.01);
    expect(context.stopRisk).toBe(250);
    expect(context.account.equity).toBe(3000);
  });

  it('prices the entry off the ASK for a BUY and the BID for a SELL', async () => {
    await seedSymbol();
    await seedAccountSnapshot();

    const sell = await build();
    const buy = await build({ signal: { ...SIGNAL, direction: 'BUY' } });

    // 0.5 * 100 * price / 100 leverage
    expect(sell.context.marginRequired).toBeCloseTo((0.5 * 100 * QUOTE.bid) / 100, 6);
    expect(buy.context.marginRequired).toBeCloseTo((0.5 * 100 * QUOTE.ask) / 100, 6);
  });

  it('does not assume tick size equals point size', async () => {
    // The broker reports them separately and they are not always equal.
    await seedSymbol({ tradeTickSize: 0.05 });
    await seedAccountSnapshot();

    const { context } = await build();

    expect(context.constraints.pointSize).toBe(0.01);
    expect(context.constraints.tickSize).toBe(0.05);
  });
});

describe('committed exposure', () => {
  it('counts a RESERVED slot that has not filled yet', async () => {
    // §7's combined cap is about what this strategy could lose in total, and a
    // reservation can still become a position. Leaving it out would let the
    // second entry be approved against an allowance the first already spent.
    await seedSymbol();
    await seedAccountSnapshot();
    const decision = await prisma.xauusdM1M5Decision.create({
      data: {
        strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
        specHash: SPEC_HASH,
        accountId,
        timeframe: 'M5',
        direction: 'BUY',
        observedAt: new Date(NOW - 10_000),
        eventId: 'evt-open',
        rsiValue: 8,
        previousRsi: 10,
        threshold: 8.9,
        basisPrice: 4360,
        observationMode: 'TICK',
        volumeLots: 0.5,
        magicNumber: V2_MAGIC_M1,
        reasoning: 'test',
        evidence: {},
      },
    });
    await prisma.xauusdM1M5SlotLock.create({
      data: { accountId, timeframe: 'M5', decisionId: decision.id, state: 'SENT' },
    });

    const { context } = await build();

    expect(context.committed).toHaveLength(1);
    expect(context.committed[0]).toMatchObject({ timeframe: 'M5', reserved: true, stopRisk: 250 });
  });

  it('marks a FILLED slot as not reserved', async () => {
    await seedSymbol();
    await seedAccountSnapshot();
    const decision = await prisma.xauusdM1M5Decision.create({
      data: {
        strategyVersion: XAUUSD_M1M5_STRATEGY_VERSION,
        specHash: SPEC_HASH,
        accountId,
        timeframe: 'M5',
        direction: 'BUY',
        observedAt: new Date(NOW - 10_000),
        eventId: 'evt-filled',
        rsiValue: 8,
        previousRsi: 10,
        threshold: 8.9,
        basisPrice: 4360,
        observationMode: 'TICK',
        volumeLots: 0.5,
        reasoning: 'test',
        evidence: {},
      },
    });
    await prisma.xauusdM1M5SlotLock.create({
      data: { accountId, timeframe: 'M5', decisionId: decision.id, state: 'FILLED' },
    });

    const { context } = await build();

    expect(context.committed[0]?.reserved).toBe(false);
  });
});

describe('day loss and drawdown', () => {
  it('reports a loss against the day’s opening equity', async () => {
    await seedSymbol();
    // Opening reading for this Beirut day, then a lower one now.
    await seedAccountSnapshot(6 * 60 * 60 * 1000, 3000);
    await seedAccountSnapshot(1_000, 2900);

    const { context } = await build();

    expect(context.account.dayLoss).toBe(100);
  });

  it('never reports a negative loss when the day is up', async () => {
    // A negative "loss" would quietly enlarge the remaining allowance.
    await seedSymbol();
    await seedAccountSnapshot(6 * 60 * 60 * 1000, 3000);
    await seedAccountSnapshot(1_000, 3200);

    const { context } = await build();

    expect(context.account.dayLoss).toBe(0);
  });

  it('measures drawdown from the highest equity ever recorded', async () => {
    await seedSymbol();
    await seedAccountSnapshot(6 * 60 * 60 * 1000, 3500);
    await seedAccountSnapshot(1_000, 3000);

    const { context } = await build();

    expect(context.account.drawdown).toBe(500);
  });

  it('claims no day loss when the day’s opening equity is unknown', async () => {
    // The process may have started mid-day. Zero is reported rather than a
    // figure invented from the oldest reading that happens to be available.
    await seedSymbol();
    await seedAccountSnapshot(1_000, 2900);

    const { context } = await build();

    expect(context.account.dayLoss).toBe(0);
  });
});
