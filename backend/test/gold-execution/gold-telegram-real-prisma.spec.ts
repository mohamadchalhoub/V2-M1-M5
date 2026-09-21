import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { GoldTelegramService } from '../../src/gold-execution/gold-telegram.service';

/**
 * Task item 8 — "test the actual service and durable dedup with a clearly
 * labeled synthetic event and isolated test identity." Unlike
 * gold-telegram-routing-isolation.spec.ts (which mocks Prisma entirely),
 * this test uses a REAL PrismaClient against the real test Postgres
 * database — only the Telegram Bot API `fetch` call itself is mocked (no
 * real message is sent; no broker trade is forced). Proves the
 * GoldTelegramNotification row is actually written/read from Postgres, and
 * that the dedup check is a real DB round-trip, not the earlier unit test's
 * mocked assumption of one.
 *
 * Rows are now keyed PER RECIPIENT: the sender appends the destination chat
 * to the caller's logical key, so one event fanned out to several recipients
 * produces one row each. These cases therefore look the row up by prefix
 * rather than by the bare logical key.
 *
 * Every dedupKey/eventType here is prefixed `SYNTHETIC_TEST_` so it is
 * unambiguously distinguishable from any real trading notification in the
 * same table, and this file cleans its own rows up afterward.
 */
describe('GoldTelegramService — real Prisma-backed durable dedup (synthetic event, isolated identity)', () => {
  let prisma: PrismaClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 999999 } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeService(): GoldTelegramService {
    const config = {
      get: (key: string) => (key === 'GOLD_TELEGRAM_BOT_TOKEN' ? 'synthetic-test-token' : key === 'GOLD_TELEGRAM_CHAT_ID' ? '111222333' : undefined),
    } as unknown as ConfigService;
    return new GoldTelegramService(prisma as any, config);
  }

  it('persists a real GoldTelegramNotification row in Postgres on first send', async () => {
    const service = makeService();
    const dedupKey = `SYNTHETIC_TEST_${Date.now()}`;

    await service.notify('SYNTHETIC_TEST_EVENT', dedupKey, 'synthetic test message — not a real trading notification');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = await prisma.goldTelegramNotification.findFirst({ where: { dedupKey: { startsWith: dedupKey } } });
    expect(row).not.toBeNull();
    expect(row?.status).toBe('SENT');
    expect(row?.messageId).toBe(999999);
    expect(row?.eventType).toBe('SYNTHETIC_TEST_EVENT');
  });

  it('a second call with the SAME dedupKey is a real, Postgres-backed no-op — no second Telegram send', async () => {
    const service = makeService();
    const dedupKey = `SYNTHETIC_TEST_${Date.now()}`;

    await service.notify('SYNTHETIC_TEST_EVENT', dedupKey, 'first synthetic send');
    await service.notify('SYNTHETIC_TEST_EVENT', dedupKey, 'second synthetic send attempt — must be skipped');

    expect(fetchMock).toHaveBeenCalledTimes(1); // not 2
    const rows = await prisma.goldTelegramNotification.findMany({ where: { dedupKey: { startsWith: dedupKey } } });
    expect(rows).toHaveLength(1); // still exactly one row, not two
  });

  it('dedup survives a fresh service instance (proves it is DB-backed, not in-memory)', async () => {
    const dedupKey = `SYNTHETIC_TEST_${Date.now()}`;
    await makeService().notify('SYNTHETIC_TEST_EVENT', dedupKey, 'sent by instance A');

    // A brand-new instance (simulating a process restart) must still see the dedup row.
    fetchMock.mockClear();
    await makeService().notify('SYNTHETIC_TEST_EVENT', dedupKey, 'attempted by instance B — must be skipped');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a FAILED synthetic send is recorded with status FAILED, distinct from SENT', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ ok: false, description: 'synthetic simulated failure' }) });
    const service = makeService();
    const dedupKey = `SYNTHETIC_TEST_${Date.now()}`;

    await service.notify('SYNTHETIC_TEST_EVENT', dedupKey, 'synthetic failing send');

    const row = await prisma.goldTelegramNotification.findFirst({ where: { dedupKey: { startsWith: dedupKey } } });
    expect(row?.status).toBe('FAILED');
    expect(row?.lastError).toBeTruthy();
  });
});
