/**
 * The active strategy's execution path, end to end through the real HTTP
 * stack: coordinator decision -> collector poll -> pre-send recheck ->
 * broker-reported result.
 *
 * The scenarios that matter most are the refusals. A gate that lets an order
 * through when it should not is the failure mode with consequences, so most
 * of what follows plants a decision that looks ready and then proves it does
 * not reach the collector.
 */
import { writeFileSync, rmSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';
import { RSI_MAGIC_EXTREME, RSI_MAGIC_RETEST } from '../../src/xauusd-rsi/safety-constants';
import { getRsiKillSwitchPath, getRsiStopNewEntriesPath } from '../../src/xauusd-rsi/controls';
import { SPEC, SPEC_HASH } from '../../src/xauusd-rsi/spec';
import { RsiAccountStateService } from '../../src/xauusd-rsi/account-state.service';
import { RsiDecisionService } from '../../src/xauusd-rsi/decision.service';

/**
 * Wednesday 2026-09-23, 15:00 Beirut — a plainly eligible instant: not in the
 * daily pause, not Friday, and well away from every boundary, so a failure
 * here is never a schedule artefact.
 */
const ELIGIBLE_T = Date.parse('2026-09-23T12:00:00.000Z');

describe('XAUUSD RSI execution — collector poll and report', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  // The shared test environment pins the mode to OFF so nothing can submit by
  // accident. This file is specifically about the submission path, so it opts
  // in explicitly and puts the value back afterwards.
  let originalMode: string | undefined;

  beforeAll(async () => {
    originalMode = process.env.XAUUSD_RSI_EXECUTION_MODE;
    process.env.XAUUSD_RSI_EXECUTION_MODE = 'DEMO';
    app = await createTestApp();
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    if (originalMode === undefined) delete process.env.XAUUSD_RSI_EXECUTION_MODE;
    else process.env.XAUUSD_RSI_EXECUTION_MODE = originalMode;
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });
  afterEach(() => {
    // Never leave a control engaged for the next case.
    rmSync(getRsiKillSwitchPath(), { force: true });
    rmSync(getRsiStopNewEntriesPath(), { force: true });
  });

  /**
   * Everything the pre-send guard needs to say yes: a fresh quote at an
   * eligible instant, a DEMO snapshot, and current symbol metadata.
   */
  async function seedPrerequisites(accountId: string) {
    await prisma.liveTick.upsert({
      where: { symbol: 'XAUUSD' },
      // Seeded at real now, not at ELIGIBLE_T: the pre-send check resolves a
      // real quote and refuses one dated days away, which a fixed future
      // fixture date would be. ELIGIBLE_T still pins the SCHEDULE-specific
      // cases, which call preSendCheck directly with an explicit clock.
      create: { symbol: 'XAUUSD', bid: 4345.45, ask: 4345.63, tickAt: new Date() },
      update: { bid: 4345.45, ask: 4345.63, tickAt: new Date() },
    });
    await prisma.accountSnapshot.create({
      data: {
        accountId, tradeMode: 'DEMO', balance: 50000, equity: 50000,
        margin: 0, freeMargin: 50000, profit: 0, capturedAt: new Date(ELIGIBLE_T),
      },
    });
    await prisma.symbolMetadata.upsert({
      where: { symbol: 'XAUUSD' },
      create: {
        symbol: 'XAUUSD', volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, digits: 2,
        point: 0.01, contractSize: 100, profitCurrency: 'USD', tradeStopsLevel: 0,
        tradeFreezeLevel: 0, tradeTickSize: 0.01, tradeMode: 4,
      },
      update: { updatedAt: new Date() },
    });
  }

  let eventSeq = 0;

  async function queueDecision(accountId: string, overrides: Record<string, unknown> = {}) {
    eventSeq += 1;
    return prisma.xauusdRsiDecision.create({
      data: {
        strategyVersion: SPEC.strategyVersion,
        specHash: SPEC_HASH,
        accountId,
        symbol: 'XAUUSD',
        observedAt: new Date(ELIGIBLE_T),
        direction: 'SELL',
        ruleFamily: 'RETEST',
        eventId: `test-event-${eventSeq}`,
        setupKinds: ['SELL_PEAK_RETEST'],
        rsiValue: 92.5,
        previousRsi: 90.1,
        basisPrice: 4345.45,
        observationMode: 'TICK',
        entryPrice: 4345.45,
        requestedPrice: 4345.45,
        stopLoss: 4350.45,
        takeProfit: 4340.45,
        volumeLots: 0.5,
        reasoning: 'planted by an execution test',
        evidence: {},
        approved: true,
        orderStatus: 'PENDING',
        magicNumber: RSI_MAGIC_RETEST,
        ...overrides,
      },
    });
  }

  const poll = (accountId: string, token: string) =>
    request(app, {
      method: 'GET',
      url: `/collector/${accountId}/xauusd-rsi/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

  it('serves a correctly-shaped order with the $5 brackets and this strategy’s own magic number', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await seedPrerequisites(account.id);
    const decision = await queueDecision(account.id);

    const res = await poll(account.id, token);

    expect(res.statusCode).toBe(200);
    const order = res.body.order;
    expect(order).not.toBeNull();
    expect(order.decisionId).toBe(decision.id);
    expect(order.side).toBe('SELL');
    expect(order.symbol).toBe('XAUUSD');
    // The RETEST family's own magic, so the resulting ticket is attributable
    // to one slot rather than merely to this strategy.
    expect(order.magic).toBe(RSI_MAGIC_RETEST);
    expect(order.ruleFamily).toBe('RETEST');
    expect(order.magic).not.toBe(RSI_MAGIC_EXTREME);
    // Never the retired strategies' numbers.
    expect(order.magic).not.toBe(262610181);
    expect(order.magic).not.toBe(262610180);
    expect(order.volume).toBe(0.5);
    expect(order.pointSize).toBe(0.01);
    // $5 at $0.01 per point.
    expect(order.stopLossPoints).toBeCloseTo(500, 3);
    expect(order.takeProfitPoints).toBeCloseTo(500, 3);
    // Absolute levels travel alongside the distances so the executor can
    // verify rather than re-derive them.
    expect(order.stopLoss).toBeCloseTo(4350.45, 6);
    expect(order.takeProfit).toBeCloseTo(4340.45, 6);
  });

  it('claims atomically — a second poll sees nothing', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await seedPrerequisites(account.id);
    await queueDecision(account.id);

    const first = await poll(account.id, token);
    const second = await poll(account.id, token);

    expect(first.body.order).not.toBeNull();
    expect(second.body.order).toBeNull();
  });

  it('serves the volume the risk gate approved, not a value re-read from live settings', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await seedPrerequisites(account.id);
    await queueDecision(account.id, { volumeLots: 0.03 });

    const res = await poll(account.id, token);
    expect(res.body.order.volume).toBe(0.03);
  });

  describe('the pre-send recheck cancels rather than sends', () => {
    it('when the kill switch engaged after queuing', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      const decision = await queueDecision(account.id);

      writeFileSync(getRsiKillSwitchPath(), 'engaged by a test');

      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();

      // Already claimed, so it must be explicitly cancelled — never left SENT.
      const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
      expect(after.orderStatus).toBe('NONE');
      expect(after.skipReason).toMatch(/pre-send check/);
      expect(after.skipReason).toMatch(/Kill switch/);
    });

    it('when stop-new-entries engaged after queuing', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      const decision = await queueDecision(account.id);

      writeFileSync(getRsiStopNewEntriesPath(), 'engaged by a test');

      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();
      const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
      expect(after.orderStatus).toBe('NONE');
      expect(after.skipReason).toMatch(/STOP NEW ENTRIES/);
    });

    /**
     * These two pin a SCHEDULE instant, which can no longer be smuggled in
     * through the quote's timestamp: the quote must now be genuinely fresh,
     * so a fixture dated days away is refused before the schedule is ever
     * consulted. They call preSendCheck directly with an explicit evaluation
     * clock and a quote that is fresh at that instant, which tests the same
     * behaviour more directly than routing it through HTTP.
     */
    async function preSendAt(accountId: string, decisionId: string, at: number) {
      await prisma.liveTick.update({
        where: { symbol: 'XAUUSD' },
        data: { bid: 4345.45, ask: 4345.63, tickAt: new Date(at - 1_000) },
      });
      const accountState = new RsiAccountStateService(prisma as never);
      const decisions = new RsiDecisionService(prisma as never, accountState);
      return decisions.preSendCheck(
        { decisionId, accountId, action: 'OPEN_SELL', entryPrice: 4345.45, observedAtT: at - 2_000, family: 'RETEST' },
        new Date(at),
      );
    }

    it('when the Friday cutoff has been reached by send time', async () => {
      const { account } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      const decision = await queueDecision(account.id);

      // Friday 2026-09-25, 23:05 Beirut — past the 23:00 cutoff.
      const result = await preSendAt(account.id, decision.id, Date.parse('2026-09-25T20:05:00.000Z'));

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/FRIDAY_ENTRY_CUTOFF/);
    });

    it('when the daily pause has begun by send time', async () => {
      const { account } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      const decision = await queueDecision(account.id);

      // Wednesday 23:35 Beirut, inside the 23:30-01:00 pause.
      const result = await preSendAt(account.id, decision.id, Date.parse('2026-09-23T20:35:00.000Z'));

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/DAILY_PAUSE|Schedule/);
    });

    it('when the account is no longer DEMO', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      const decision = await queueDecision(account.id);

      await prisma.accountSnapshot.create({
        data: {
          accountId: account.id, tradeMode: 'REAL', balance: 50000, equity: 50000,
          margin: 0, freeMargin: 50000, profit: 0, capturedAt: new Date(ELIGIBLE_T + 1000),
        },
      });

      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();
      const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
      expect(after.skipReason).toMatch(/not DEMO/);
    });

    it('when the signal has gone stale by send time', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      // Observed two minutes before the evaluation clock; the limit is 60s.
      // Relative to real time, because the pre-send check now evaluates at
      // the real server instant rather than at the quote's timestamp.
      await queueDecision(account.id, { observedAt: new Date(Date.now() - 120_000) });

      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();
    });

    it('when the price has drifted beyond the deviation limit', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      // 100pt = $1.00 is the limit; move the quote $3.
      await prisma.liveTick.update({
        where: { symbol: 'XAUUSD' },
        data: { bid: 4348.45, ask: 4348.63, tickAt: new Date() },
      });

      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();
    });

    it("when a position took this decision's OWN family slot since queuing", async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      await queueDecision(account.id); // RETEST

      await prisma.position.create({
        data: {
          accountId: account.id, platform: 'MT5', externalPositionId: '5001', symbol: 'XAUUSD',
          side: 'BUY', volume: 0.1, openPrice: 4340, profit: 0, swap: 0,
          openedAt: new Date(ELIGIBLE_T), status: 'OPEN',
          rawPayload: { magic: RSI_MAGIC_RETEST },
        },
      });

      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();
    });

    it('when UNATTRIBUTABLE foreign exposure appeared since queuing', async () => {
      // The two-slot change relaxed same-symbol occupancy for this strategy's
      // OWN slots. It did not relax the refusal to trade alongside exposure
      // whose size and management this application does not control.
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      await queueDecision(account.id);

      await prisma.position.create({
        data: {
          accountId: account.id, platform: 'MT5', externalPositionId: '9001', symbol: 'XAUUSD',
          side: 'BUY', volume: 0.1, openPrice: 4340, profit: 0, swap: 0,
          openedAt: new Date(ELIGIBLE_T), status: 'OPEN',
          rawPayload: { magic: 777777 },
        },
      });

      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();
    });

    it('but NOT when the OTHER family holds a position', async () => {
      // This is the behaviour the two-slot change exists for: an open EXTREME
      // position must not block a RETEST entry.
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      await queueDecision(account.id); // RETEST

      await prisma.position.create({
        data: {
          accountId: account.id, platform: 'MT5', externalPositionId: '5002', symbol: 'XAUUSD',
          side: 'BUY', volume: 0.5, openPrice: 4340, profit: 0, swap: 0,
          openedAt: new Date(ELIGIBLE_T), status: 'OPEN',
          rawPayload: { magic: RSI_MAGIC_EXTREME },
        },
      });

      const res = await poll(account.id, token);
      expect(res.body.order).not.toBeNull();
      expect(res.body.order.ruleFamily).toBe('RETEST');
    });

    it('when the quote itself has gone stale, however fresh the signal looks', async () => {
      // The frozen-feed case. The quote is far older than the 30s limit
      // measured against REAL time, while the signal looks young because it
      // was observed just after that same frozen quote. Before the quote's
      // own age was checked, this combination sailed through: the stopped
      // feed was also the clock the signal was aged against.
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      const frozenAt = new Date(Date.now() - 10 * 60_000);
      await prisma.liveTick.update({
        where: { symbol: 'XAUUSD' },
        data: { bid: 4345.45, ask: 4345.63, tickAt: frozenAt },
      });
      await queueDecision(account.id, { observedAt: new Date(frozenAt.getTime() - 1_000) });

      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();
      const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: (await prisma.xauusdRsiDecision.findFirstOrThrow({ where: { accountId: account.id }, orderBy: { evaluatedAt: 'desc' } })).id } });
      expect(after.skipReason).toMatch(/quote is .* old at the pre-send check/);
    });

    it('re-reading the same frozen tick does not refresh it into acceptance', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      await seedPrerequisites(account.id);
      const frozenAt = new Date(Date.now() - 10 * 60_000);
      await prisma.liveTick.update({
        where: { symbol: 'XAUUSD' },
        data: { bid: 4345.45, ask: 4345.63, tickAt: frozenAt },
      });
      await queueDecision(account.id, { observedAt: new Date(frozenAt.getTime() - 1_000) });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await poll(account.id, token);
        expect(res.body.order).toBeNull();
      }
      // The stored timestamp is untouched by having been read three times.
      const tickNow = await prisma.liveTick.findUniqueOrThrow({ where: { symbol: 'XAUUSD' } });
      expect(tickNow.tickAt.getTime()).toBe(frozenAt.getTime());
    });

    it('when there is no live quote at all — refusing to send blind', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      // Deliberately no LiveTick row.
      await prisma.accountSnapshot.create({
        data: {
          accountId: account.id, tradeMode: 'DEMO', balance: 50000, equity: 50000,
          margin: 0, freeMargin: 50000, profit: 0, capturedAt: new Date(),
        },
      });
      await queueDecision(account.id);

      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();
    });
  });

  describe('result reporting', () => {
    async function claimed(accountId: string, token: string) {
      await seedPrerequisites(accountId);
      const decision = await queueDecision(accountId);
      await poll(accountId, token);
      return decision;
    }

    it('records a confirmed fill with slippage and broker-reported protection', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      const decision = await claimed(account.id, token);

      const res = await request(app, {
        method: 'POST',
        url: `/collector/${account.id}/xauusd-rsi/pending-order/${decision.id}/result`,
        headers: { authorization: `Bearer ${token}` },
        payload: { ok: true, ticket: 7777, filledPrice: 4345.5, brokerStopLoss: 4350.5, brokerTakeProfit: 4340.5 },
      });
      expect(res.statusCode).toBeLessThan(300);

      const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
      expect(after.orderStatus).toBe('FILLED');
      expect(String(after.mt5Ticket)).toBe('7777');
      expect(after.filledPrice?.toNumber()).toBeCloseTo(4345.5, 6);
      // |4345.5 - 4345.45| / 0.01 = 5 points
      expect(after.slippagePoints?.toNumber()).toBeCloseTo(5, 3);
      expect(after.brokerStopLoss?.toNumber()).toBeCloseTo(4350.5, 6);
      expect(after.filledAt).not.toBeNull();
    });

    it('records an 11-digit MT5 ticket, which used to overflow the column', async () => {
      // Found in live operation: the broker returned ticket 58537207521 for a
      // real filled position. The column was INT4, so recordExecutionResult
      // threw, the fill was never recorded, the decision stayed SENT and its
      // slot was never released — blocking every further entry in that family.
      const { account, token } = await setupAccountWithToken(prisma);
      const decision = await claimed(account.id, token);

      const bigTicket = 58537207521;
      expect(bigTicket).toBeGreaterThan(2_147_483_647); // beyond INT4

      const res = await request(app, {
        method: 'POST',
        url: `/collector/${account.id}/xauusd-rsi/pending-order/${decision.id}/result`,
        headers: { authorization: `Bearer ${token}` },
        payload: { ok: true, ticket: bigTicket, filledPrice: 4345.7, brokerStopLoss: 4340.7, brokerTakeProfit: 4350.7 },
      });
      expect(res.statusCode).toBeLessThan(300);

      const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
      expect(after.orderStatus).toBe('FILLED');
      expect(String(after.mt5Ticket)).toBe('58537207521');
    });

    it('records a clear rejection as FAILED', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      const decision = await claimed(account.id, token);

      await request(app, {
        method: 'POST',
        url: `/collector/${account.id}/xauusd-rsi/pending-order/${decision.id}/result`,
        headers: { authorization: `Bearer ${token}` },
        payload: { ok: false, errorMessage: 'invalid stops' },
      });

      const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
      expect(after.orderStatus).toBe('FAILED');
      expect(after.executionError).toBe('invalid stops');
      expect(after.filledAt).toBeNull();
    });

    it('records an ambiguous response as UNKNOWN, NOT as FAILED', async () => {
      // This is the distinction that keeps the position slot occupied. Marking
      // a lost response as failed would let a second order through while the
      // first may well be open at the broker.
      const { account, token } = await setupAccountWithToken(prisma);
      const decision = await claimed(account.id, token);

      await request(app, {
        method: 'POST',
        url: `/collector/${account.id}/xauusd-rsi/pending-order/${decision.id}/result`,
        headers: { authorization: `Bearer ${token}` },
        payload: { ok: false, uncertain: true, errorMessage: 'no response from terminal' },
      });

      const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: decision.id } });
      expect(after.orderStatus).toBe('UNKNOWN');
      expect(after.filledAt).toBeNull();
    });

    it("an UNKNOWN decision still occupies its OWN family's slot", async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      const decision = await claimed(account.id, token);
      await request(app, {
        method: 'POST',
        url: `/collector/${account.id}/xauusd-rsi/pending-order/${decision.id}/result`,
        headers: { authorization: `Bearer ${token}` },
        payload: { ok: false, uncertain: true, errorMessage: 'lost' },
      });

      // A second slot-holding RETEST row cannot even be CREATED: the partial
      // unique index rejects it, which is the atomic half of the reservation.
      await expect(queueDecision(account.id)).rejects.toThrow();

      // And nothing is served.
      const res = await poll(account.id, token);
      expect(res.body.order).toBeNull();
    });

    it('but the OTHER family can still be served while one is UNKNOWN', async () => {
      const { account, token } = await setupAccountWithToken(prisma);
      const decision = await claimed(account.id, token); // RETEST
      await request(app, {
        method: 'POST',
        url: `/collector/${account.id}/xauusd-rsi/pending-order/${decision.id}/result`,
        headers: { authorization: `Bearer ${token}` },
        payload: { ok: false, uncertain: true, errorMessage: 'lost' },
      });

      await queueDecision(account.id, { ruleFamily: 'EXTREME', magicNumber: RSI_MAGIC_EXTREME, setupKinds: ['EXTREME_SELL'] });
      const res = await poll(account.id, token);
      expect(res.body.order).not.toBeNull();
      expect(res.body.order.magic).toBe(RSI_MAGIC_EXTREME);
    });
  });

  it('rejects a poll for an account the token is not bound to', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const other = await setupAccountWithToken(prisma);

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${other.account.id}/xauusd-rsi/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
