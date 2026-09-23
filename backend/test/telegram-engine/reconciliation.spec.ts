/**
 * Reconciliation and crash safety, against a REAL database.
 *
 * Everything here is about the gap between "we told the broker something" and
 * "we know what the broker did". The cases are the ones that actually happen:
 * a process that dies between two legs, a response that is lost, a snapshot
 * that came back incomplete, and a position at the broker that matches
 * nothing we have a record of.
 *
 * The single rule every case is measured against: **a position missing from a
 * snapshot is not a closure** unless the snapshot was complete.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TelegramReconciliationService } from '../../src/telegram-engine/reconciliation.service';
import { TelegramLegQueueService } from '../../src/telegram-engine/leg-queue.service';
import { legIdempotencyTag, legOrderComment, tagFromComment } from '../../src/telegram-engine/idempotency';
import { TELEGRAM_MAGIC } from '../../src/telegram-engine/safety-constants';
import { TELEGRAM_SPEC } from '../../src/telegram-engine/spec';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../../src/xauusd-m1m5/safety-constants';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
const reconciliation = new TelegramReconciliationService(prisma);
const legs = new TelegramLegQueueService(prisma);

const NOW = Date.UTC(2026, 8, 23, 13, 0, 0);
let accountId: string;
const savedEnv: Record<string, string | undefined> = {};

/** A two-leg SELL signal with both legs marked as sent but unanswered. */
async function twoLegSignal(over: { legStatus?: 'PENDING' | 'UNKNOWN' | 'FILLED'; publishedAtMs?: number } = {}) {
  const signal = await prisma.telegramSignal.create({
    data: {
      engineVersion: 'telegram-sfxauusd1-copy-v1',
      accountId,
      channelId: '-1001234567890',
      messageId: `m-${Math.random().toString(36).slice(2)}`,
      sourceKey: `k-${Math.random().toString(36).slice(2)}`,
      semanticKey: `s-${Math.random().toString(36).slice(2)}`,
      publishedAt: new Date(over.publishedAtMs ?? NOW - 5_000),
      receivedAt: new Date(NOW - 4_000),
      rawText: 'Gold sell now 4338\nSL 4348\nTP 4329\nTP 4300',
      direction: 'SELL',
      entry: 4338,
      stopLoss: 4348,
      takeProfits: [4329, 4300],
      tp1: 4329,
      outcome: 'SUBMITTED',
      detail: 'test fixture',
      evidence: {},
    },
  });
  const created = [];
  for (const [i, tp] of [4329, 4300].entries()) {
    created.push(
      await prisma.telegramSignalLeg.create({
        data: {
          signalId: signal.id,
          legIndex: i + 1,
          idempotencyTag: legIdempotencyTag(signal.id, i + 1),
          direction: 'SELL',
          volumeLots: 0.01,
          sourceEntry: 4338,
          stopLoss: 4348,
          takeProfit: tp,
          magicNumber: TELEGRAM_MAGIC,
          orderStatus: over.legStatus ?? 'UNKNOWN',
        },
      }),
    );
  }
  await prisma.telegramSignalGroupLock.create({
    data: { accountId, signalId: signal.id, state: 'SENT' },
  });
  return { signal, legs: created };
}

function position(tag: string, over: Record<string, unknown> = {}) {
  return {
    ticket: '900001',
    magic: TELEGRAM_MAGIC,
    symbol: 'XAUUSD',
    comment: legOrderComment(tag, 1),
    volume: 0.01,
    openPrice: 4338,
    stopLoss: 4348,
    takeProfit: 4329,
    profit: 1.2,
    ...over,
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  const account = await createTradingAccount(prisma, user.id);
  accountId = account.id;
  for (const k of ['TELEGRAM_ENGINE_ENABLED', 'TELEGRAM_ENGINE_KILL_SWITCH', 'V2_GLOBAL_KILL_SWITCH']) {
    savedEnv[k] = process.env[k];
  }
  process.env.TELEGRAM_ENGINE_ENABLED = 'true';
  delete process.env.TELEGRAM_ENGINE_KILL_SWITCH;
  delete process.env.V2_GLOBAL_KILL_SWITCH;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await prisma.$disconnect();
});

describe('an UNKNOWN leg that is actually live at the broker', () => {
  it('is recorded as FILLED rather than re-sent', async () => {
    const { signal, legs: rows } = await twoLegSignal({ legStatus: 'UNKNOWN' });
    const tag = rows[0].idempotencyTag;

    const outcome = await reconciliation.reconcile({
      accountId,
      nowMs: NOW,
      snapshotComplete: true,
      snapshotAtMs: NOW,
      positions: [position(tag)],
      deals: [],
    });

    expect(outcome.resolvedUnknown).toBeGreaterThanOrEqual(1);
    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.orderStatus).toBe('FILLED');
    expect(String(leg1!.ticket)).toBe('900001');
    expect(leg1!.reconciledAt).not.toBeNull();
    expect(signal.id).toBeTruthy();
  });

  it('matches by LEG tag, not by magic number', async () => {
    // Both legs carry TELEGRAM_MAGIC. Only leg 1's tag is at the broker, so
    // only leg 1 may be resolved as filled — a magic-only match would mark
    // both.
    const { legs: rows } = await twoLegSignal({ legStatus: 'UNKNOWN' });
    await reconciliation.reconcile({
      accountId,
      nowMs: NOW,
      snapshotComplete: true,
      snapshotAtMs: NOW,
      positions: [position(rows[0].idempotencyTag)],
      deals: [],
    });

    const leg2 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[1].id } });
    expect(leg2!.orderStatus).not.toBe('FILLED');
  });

  it('records a protection incident when a live position has no stop loss', async () => {
    const { legs: rows } = await twoLegSignal({ legStatus: 'FILLED' });
    await reconciliation.reconcile({
      accountId,
      nowMs: NOW,
      snapshotComplete: true,
      snapshotAtMs: NOW,
      positions: [position(rows[0].idempotencyTag, { stopLoss: null })],
      deals: [],
    });

    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.protectionIncident).toMatch(/no stop loss|unprotected/i);
  });
});

describe('an incomplete snapshot concludes nothing', () => {
  it('does not close a leg that is absent from an INCOMPLETE snapshot', async () => {
    const { legs: rows } = await twoLegSignal({ legStatus: 'FILLED' });

    const outcome = await reconciliation.reconcile({
      accountId,
      nowMs: NOW,
      snapshotComplete: false,
      snapshotAtMs: NOW,
      positions: [],
      deals: [],
    });

    expect(outcome.closedLegs).toBe(0);
    expect(outcome.recoveryComplete).toBe(false);
    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.closureComplete).toBe(false);
    expect(leg1!.orderStatus).toBe('FILLED');
  });

  it('says so plainly, rather than reporting a clean pass', async () => {
    await twoLegSignal({ legStatus: 'FILLED' });
    const outcome = await reconciliation.reconcile({
      accountId, nowMs: NOW, snapshotComplete: false, snapshotAtMs: NOW, positions: [], deals: [],
    });
    expect(outcome.detail).toMatch(/INCOMPLETE/);
  });
});

describe('closure from complete evidence', () => {
  it('closes a filled leg when a complete snapshot has a matching closing deal', async () => {
    const { legs: rows } = await twoLegSignal({ legStatus: 'FILLED' });
    const tag = rows[0].idempotencyTag;

    const outcome = await reconciliation.reconcile({
      accountId,
      nowMs: NOW,
      snapshotComplete: true,
      snapshotAtMs: NOW,
      positions: [],
      deals: [
        { ticket: '5001', positionId: null, magic: TELEGRAM_MAGIC, comment: legOrderComment(tag, 1), profit: 0.9, closedAtMs: NOW - 1000 },
      ],
    });

    expect(outcome.closedLegs).toBeGreaterThanOrEqual(1);
    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.closureComplete).toBe(true);
    expect(Number(leg1!.realizedPl)).toBeCloseTo(0.9, 6);
  });

  it('resolves an UNKNOWN leg to FAILED when a complete snapshot shows no position and no deal', async () => {
    const { legs: rows } = await twoLegSignal({ legStatus: 'UNKNOWN' });
    await reconciliation.reconcile({
      accountId, nowMs: NOW, snapshotComplete: true, snapshotAtMs: NOW, positions: [], deals: [],
    });
    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.orderStatus).toBe('FAILED');
  });
});

describe('recoveryComplete is earned, never assumed', () => {
  it('is false before any pass has run', async () => {
    const state = await prisma.telegramReconciliationState.findUnique({ where: { accountId } });
    expect(state).toBeNull();
  });

  it('becomes true only after a complete pass with nothing unresolved', async () => {
    await twoLegSignal({ legStatus: 'FILLED' });
    const outcome = await reconciliation.reconcile({
      accountId,
      nowMs: NOW,
      snapshotComplete: true,
      snapshotAtMs: NOW,
      positions: [],
      deals: [],
    });
    expect(outcome.recoveryComplete).toBe(true);
    const state = await prisma.telegramReconciliationState.findUnique({ where: { accountId } });
    expect(state!.recoveryComplete).toBe(true);
    expect(state!.lastCompletedAt).not.toBeNull();
  });

  it('does not stay blocked forever by a leg the collector abandoned', async () => {
    // The collector claimed this leg and then died. Nobody will ever report
    // it; past its lifetime it can no longer be sent; a complete snapshot
    // shows nothing at the broker. Left unresolved it would disable Engine B
    // permanently, so reconciliation closes it out.
    // ABANDONED_PENDING_LEG_MS is 10x the 1-hour execution lifetime, so this
    // must be well past 10 hours.
    const { legs: rows } = await twoLegSignal({ legStatus: 'PENDING', publishedAtMs: NOW - 11 * 60 * 60_000 });

    const outcome = await reconciliation.reconcile({
      accountId, nowMs: NOW, snapshotComplete: true, snapshotAtMs: NOW, positions: [], deals: [],
    });

    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.orderStatus).toBe('SKIPPED');
    expect(leg1!.skipReason).toBe('TELEGRAM_ABANDONED_BEFORE_SUBMISSION');
    expect(outcome.recoveryComplete).toBe(true);
  });

  it('does NOT close out a leg that is merely slow', async () => {
    // Queued seconds ago. Genuinely in flight, and closing it out here would
    // race the collector that is about to send it.
    const { legs: rows } = await twoLegSignal({ legStatus: 'PENDING', publishedAtMs: NOW - 5_000 });

    const outcome = await reconciliation.reconcile({
      accountId, nowMs: NOW, snapshotComplete: true, snapshotAtMs: NOW, positions: [], deals: [],
    });

    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.orderStatus).toBe('PENDING');
    expect(outcome.recoveryComplete).toBe(false);
  });

  it('stays false while a leg is still PENDING at the broker', async () => {
    await twoLegSignal({ legStatus: 'PENDING' });
    const outcome = await reconciliation.reconcile({
      accountId, nowMs: NOW, snapshotComplete: true, snapshotAtMs: NOW, positions: [], deals: [],
    });
    expect(outcome.unresolvedLegs).toBeGreaterThan(0);
    expect(outcome.recoveryComplete).toBe(false);
  });
});

describe('an unattributable Telegram-magic position', () => {
  it('is never adopted, and blocks recovery', async () => {
    await twoLegSignal({ legStatus: 'FILLED' });
    const outcome = await reconciliation.reconcile({
      accountId,
      nowMs: NOW,
      snapshotComplete: true,
      snapshotAtMs: NOW,
      // Telegram magic, but a comment the broker mangled beyond recognition.
      positions: [position('unknown', { comment: 'manual close', ticket: '777' })],
      deals: [],
    });

    expect(outcome.foreignTelegramPositions).toContain('777');
    expect(outcome.recoveryComplete).toBe(false);
  });
});

describe('other engines’ positions are not this engine’s business', () => {
  it('ignores Engine A and manual positions entirely', async () => {
    const { legs: rows } = await twoLegSignal({ legStatus: 'UNKNOWN' });
    const outcome = await reconciliation.reconcile({
      accountId,
      nowMs: NOW,
      snapshotComplete: true,
      snapshotAtMs: NOW,
      positions: [
        { ...position(rows[0].idempotencyTag) },
        { ...position('x', { magic: V2_MAGIC_M1, ticket: '111', comment: 'm1m5-m1-abc' }) },
        { ...position('y', { magic: V2_MAGIC_M5, ticket: '222', comment: 'm1m5-m5-def' }) },
        { ...position('z', { magic: null, ticket: '333', comment: null }) },
      ],
      deals: [],
    });

    // Engine A's and the manual position are not reported as unattributable
    // Telegram positions, because they were never selected in the first place.
    expect(outcome.foreignTelegramPositions).not.toContain('111');
    expect(outcome.foreignTelegramPositions).not.toContain('222');
    expect(outcome.foreignTelegramPositions).not.toContain('333');
    expect(outcome.recoveryComplete).toBe(true);
  });
});

describe('the leg queue is the last gate before the terminal', () => {
  it('cancels a leg that has aged past its lifetime while it waited', async () => {
    const { legs: rows } = await twoLegSignal({
      legStatus: 'PENDING',
      publishedAtMs: NOW - (TELEGRAM_SPEC.maxSignalAgeMs + 90_000),
    });
    const claimed = await legs.claimNext(accountId, NOW);
    expect(claimed).toBeNull();

    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.orderStatus).toBe('SKIPPED');
    expect(leg1!.skipReason).toBe('TELEGRAM_SIGNAL_EXPIRED');
  });

  it('cancels a leg whose signal was spent while it waited', async () => {
    const { signal, legs: rows } = await twoLegSignal({ legStatus: 'PENDING' });
    await prisma.telegramSignal.update({
      where: { id: signal.id },
      data: { tp1Touched: true, tp1TouchedAt: new Date(NOW), tp1TouchPrice: 4329 },
    });

    const claimed = await legs.claimNext(accountId, NOW);
    expect(claimed).toBeNull();
    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.skipReason).toBe('TELEGRAM_TP1_ALREADY_REACHED');
  });

  it('offers a fresh leg with the SOURCE levels and its tag', async () => {
    const { legs: rows } = await twoLegSignal({ legStatus: 'PENDING' });
    const claimed = await legs.claimNext(accountId, NOW);

    expect(claimed).not.toBeNull();
    expect(claimed!.stopLoss).toBe(4348);
    expect(claimed!.takeProfit).toBe(4329);
    expect(claimed!.volume).toBe(0.01);
    expect(claimed!.magic).toBe(TELEGRAM_MAGIC);
    expect(claimed!.tp1).toBe(4329);
    expect(tagFromComment(claimed!.comment)).toBe(rows[0].idempotencyTag);
  });

  it('offers a leg only once, so two collector passes cannot both send it', async () => {
    await twoLegSignal({ legStatus: 'PENDING' });
    const first = await legs.claimNext(accountId, NOW);
    const second = await legs.claimNext(accountId, NOW);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Different legs, never the same one twice.
    expect(second!.legId).not.toBe(first!.legId);

    const third = await legs.claimNext(accountId, NOW);
    expect(third).toBeNull();
  });

  it('cancels every pending leg when the kill switch is engaged', async () => {
    const { legs: rows } = await twoLegSignal({ legStatus: 'PENDING' });
    process.env.TELEGRAM_ENGINE_KILL_SWITCH = 'true';

    const claimed = await legs.claimNext(accountId, NOW);
    expect(claimed).toBeNull();
    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.orderStatus).toBe('SKIPPED');
    expect(leg1!.skipReason).toMatch(/CONTROL_BLOCKED/);
  });

  it('records an UNKNOWN broker answer as UNKNOWN and keeps the group held', async () => {
    const { signal, legs: rows } = await twoLegSignal({ legStatus: 'PENDING' });
    await legs.recordResult(rows[0].id, {
      ok: false,
      ticket: null,
      filledPrice: null,
      brokerStopLoss: null,
      brokerTakeProfit: null,
      errorMessage: 'timeout',
      uncertain: true,
    });

    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.orderStatus).toBe('UNKNOWN');
    const lock = await prisma.telegramSignalGroupLock.findFirst({ where: { signalId: signal.id } });
    expect(lock).not.toBeNull();
  });

  it('flags a fill whose broker protection could not be verified', async () => {
    const { legs: rows } = await twoLegSignal({ legStatus: 'PENDING' });
    await legs.recordResult(rows[0].id, {
      ok: true,
      ticket: '900002',
      filledPrice: 4338,
      brokerStopLoss: null,
      brokerTakeProfit: null,
      errorMessage: null,
      uncertain: false,
    });

    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.orderStatus).toBe('FILLED');
    expect(leg1!.protectionIncident).toMatch(/not a clean trade|could not be verified/i);
  });

  it('accepts a fill whose broker protection matches the published levels', async () => {
    const { legs: rows } = await twoLegSignal({ legStatus: 'PENDING' });
    await legs.recordResult(rows[0].id, {
      ok: true,
      ticket: '900003',
      filledPrice: 4338,
      brokerStopLoss: 4348,
      brokerTakeProfit: 4329,
      errorMessage: null,
      uncertain: false,
    });

    const leg1 = await prisma.telegramSignalLeg.findUnique({ where: { id: rows[0].id } });
    expect(leg1!.protectionIncident).toBeNull();
    expect(leg1!.protectionVerifiedAt).not.toBeNull();
  });
});

describe('the idempotency tag', () => {
  it('is stable across restarts for the same leg', () => {
    expect(legIdempotencyTag('signal-abc', 1)).toBe(legIdempotencyTag('signal-abc', 1));
  });

  it('differs between legs of one signal', () => {
    expect(legIdempotencyTag('signal-abc', 1)).not.toBe(legIdempotencyTag('signal-abc', 2));
  });

  it('survives a round trip through an MT5 comment', () => {
    const tag = legIdempotencyTag('signal-abc', 2);
    expect(tagFromComment(legOrderComment(tag, 2))).toBe(tag);
  });

  it('returns null for a comment the broker rewrote', () => {
    expect(tagFromComment('cancelled by dealer')).toBeNull();
    expect(tagFromComment(null)).toBeNull();
  });

  it('fits inside an MT5 comment field', () => {
    expect(legOrderComment(legIdempotencyTag('signal-abc', 1), 1).length).toBeLessThanOrEqual(31);
  });
});
