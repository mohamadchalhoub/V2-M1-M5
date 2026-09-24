// Gold historical-collection phase — POST/GET /collector/ticks*. No
// accountId (schema.prisma's HistoricalTick: symbol-level market data,
// shared across every account), same posture as candles.spec.ts's own
// tests for /collector/candles.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';
import { HISTORICAL_TICK_QUEUE } from '../../src/jobs/jobs.constants';

// Phase 1 CPU-isolation change (2026-09-24): POST /collector/ticks now only
// enqueues a job onto HISTORICAL_TICK_QUEUE -- the actual dedup + insert
// runs in a worker_thread (historical-tick.processor.ts /
// historical-tick-worker-thread.ts), which requires the COMPILED dist/
// output to spawn (worker_threads.Worker loads a plain .js file via Node's
// own loader, bypassing Vitest's TS transform), so it does not run inside
// this Vitest process. These tests therefore assert the new contract at
// the layer that actually runs here: the HTTP response shape, and that the
// correct job is placed on the real queue. The dedup/insert SQL itself is
// tested against a real database in
// test/market-data/historical-tick-dedup.spec.ts, and the full pipeline
// (worker_thread included) is proven end-to-end by the manual stress test
// at test/market-data/stress/historical-tick-stress.js (run against the
// built dist/ output; see that file's own docstring).

function ticksPayload(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'XAUUSD',
    brokerSymbol: 'XAUUSD.a',
    server: 'MetaQuotes-Demo',
    ticks: [
      { timestamp: '2026-01-01T00:00:00.000Z', bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0 },
      { timestamp: '2026-01-01T00:00:01.000Z', bid: 2400.2, ask: 2400.4, flags: 6, batchSeq: 1 },
    ],
    ...overrides,
  };
}

describe('historical tick ingestion (/collector/ticks)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let queue: Queue;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
    queue = app.get(HISTORICAL_TICK_QUEUE);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    // drain() only clears waiting/delayed jobs -- failed/completed jobs
    // from earlier test runs accumulate in this same real Redis instance
    // otherwise (removeOnFail/removeOnComplete only prune by age/count, not
    // per-test-run), which would make a getJobs(['...','failed',...]) read
    // in this file see stale jobs from unrelated previous runs.
    await queue.obliterate({ force: true });
  });

  it('accepts a valid push and enqueues it, unchanged, onto the historical-tick queue', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const payload = ticksPayload();
    const res = await request(app, {
      method: 'POST',
      url: '/collector/ticks',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true, queued: true });

    // Dedup/insert now happens in the worker_thread (see this file's own
    // top comment) -- what this layer owns is getting the right job onto
    // the queue, unchanged, not re-doing its insert-count arithmetic.
    // The REAL BullMQ Worker in this test's app graph picks the job up
    // immediately (concurrency:1, but immediately -- there's nothing else
    // in the way), and since the worker_thread can't spawn in this Vitest
    // process (see this file's top comment), the job fails fast rather
    // than staying 'waiting' -- so this checks every state the job could
    // legitimately be in by the time this assertion runs, not just 'waiting'.
    const jobs = await queue.getJobs(['waiting', 'active', 'failed', 'completed']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toMatchObject({
      symbol: 'XAUUSD',
      brokerSymbol: 'XAUUSD.a',
      server: 'MetaQuotes-Demo',
      ticks: payload.ticks,
    });
  });

  it('rejects an empty ticks array', async () => {
    const { token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'POST',
      url: '/collector/ticks',
      headers: { authorization: `Bearer ${token}` },
      payload: ticksPayload({ ticks: [] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a request with no bearer token at all', async () => {
    const res = await request(app, { method: 'POST', url: '/collector/ticks', payload: ticksPayload() });
    expect(res.statusCode).toBe(401);
  });

  describe('GET /collector/ticks/coverage', () => {
    it('returns zero/null coverage when nothing has been ingested', async () => {
      const { token } = await setupAccountWithToken(prisma);
      const res = await request(app, {
        method: 'GET',
        url: '/collector/ticks/coverage?symbol=XAUUSD',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ symbol: 'XAUUSD', count: 0, earliest: null, latest: null });
    });

    it('returns count/earliest/latest after ingestion, scoped by symbol', async () => {
      const { token } = await setupAccountWithToken(prisma);
      // Coverage reads directly from historical_ticks and is unchanged by
      // Phase 1 (only the POST write path moved off this thread) -- seed
      // rows directly rather than via POST, since insertion now happens in
      // a worker_thread this Vitest process cannot spawn (see this file's
      // own top comment).
      await prisma.historicalTick.createMany({
        data: [
          { symbol: 'XAUUSD', brokerSymbol: 'XAUUSD.a', server: 'MetaQuotes-Demo', timestamp: new Date('2026-01-01T00:00:00.000Z'), bid: 2400.1, ask: 2400.3, flags: 6, batchSeq: 0, source: 'MT5' },
          { symbol: 'XAUUSD', brokerSymbol: 'XAUUSD.a', server: 'MetaQuotes-Demo', timestamp: new Date('2026-01-01T00:00:01.000Z'), bid: 2400.2, ask: 2400.4, flags: 6, batchSeq: 1, source: 'MT5' },
          { symbol: 'EURUSD', brokerSymbol: 'EURUSD.a', server: 'MetaQuotes-Demo', timestamp: new Date('2026-01-01T00:00:00.000Z'), bid: 1.1, ask: 1.1002, flags: 6, batchSeq: 0, source: 'MT5' },
        ],
      });

      const res = await request(app, {
        method: 'GET',
        url: '/collector/ticks/coverage?symbol=XAUUSD',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.body.count).toBe(2);
      expect(res.body.earliest).toBe('2026-01-01T00:00:00.000Z');
      expect(res.body.latest).toBe('2026-01-01T00:00:01.000Z');
    });

    it('rejects a missing symbol query param', async () => {
      const { token } = await setupAccountWithToken(prisma);
      const res = await request(app, {
        method: 'GET',
        url: '/collector/ticks/coverage',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
