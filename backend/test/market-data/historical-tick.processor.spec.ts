/**
 * `HistoricalTickProcessor`'s own plumbing (dispatch, crash/respawn,
 * no-fallback) is pure message-passing -- tested here with a mocked
 * `node:worker_threads`, since the SQL/dedup logic it delegates to is
 * already covered against a real database in historical-tick-dedup.spec.ts.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoricalTickProcessor } from '../../src/market-data/historical-tick.processor';
import * as dedupModule from '../../src/market-data/historical-tick-dedup';

class FakeThreadWorker extends EventEmitter {
  public terminated = false;
  public messages: unknown[] = [];
  postMessage(msg: unknown): void {
    this.messages.push(msg);
  }
  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

let lastThread: FakeThreadWorker;
const spawnedThreads: FakeThreadWorker[] = [];

vi.mock('node:worker_threads', () => ({
  Worker: vi.fn().mockImplementation(() => {
    lastThread = new FakeThreadWorker();
    spawnedThreads.push(lastThread);
    return lastThread;
  }),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  Queue: vi.fn(),
}));

vi.mock('../../src/jobs/redis-connection', () => ({
  createRedisConnection: vi.fn().mockReturnValue({}),
}));

function makeConfig(): ConfigService {
  return { get: () => 'redis://localhost:6379' } as unknown as ConfigService;
}

describe('HistoricalTickProcessor', () => {
  beforeEach(() => {
    spawnedThreads.length = 0;
    vi.clearAllMocks();
  });

  it('never imports the CPU-heavy dedup/SQL module at all (structural no-fallback proof)', async () => {
    // If the processor imported historical-tick-dedup, that work could run
    // on this (main) thread. It must not.
    const processorSource = fs.readFileSync(
      path.join(__dirname, '../../src/market-data/historical-tick.processor.ts'),
      'utf8',
    );
    expect(processorSource).not.toContain('historical-tick-dedup');
    expect(dedupModule.dedupeTicks).toBeDefined(); // sanity: module itself is fine to exist elsewhere
  });

  it('dispatches a job via postMessage and resolves on the correlated reply', async () => {
    const processor = new HistoricalTickProcessor(makeConfig(), {} as Queue);
    await processor.onModuleInit();

    const job = { data: { symbol: 'XAUUSD', brokerSymbol: null, server: null, feedId: null, ticks: [] } } as Job;
    const processPromise = (processor as unknown as { process(job: Job): Promise<void> }).process(job);

    await vi.waitFor(() => expect(lastThread.messages).toHaveLength(1));
    const sent = lastThread.messages[0] as { id: number };
    lastThread.emit('message', { id: sent.id, ok: true, inserted: 0 });

    await expect(processPromise).resolves.toBeUndefined();
  });

  it('throws when the worker_thread reports failure', async () => {
    const processor = new HistoricalTickProcessor(makeConfig(), {} as Queue);
    await processor.onModuleInit();

    const job = { data: { symbol: 'XAUUSD', brokerSymbol: null, server: null, feedId: null, ticks: [] } } as Job;
    const processPromise = (processor as unknown as { process(job: Job): Promise<void> }).process(job);

    await vi.waitFor(() => expect(lastThread.messages).toHaveLength(1));
    const sent = lastThread.messages[0] as { id: number };
    lastThread.emit('message', { id: sent.id, ok: false, error: 'db unavailable' });

    await expect(processPromise).rejects.toThrow('db unavailable');
  });

  it('on worker_thread crash: rejects pending jobs and respawns a new thread (never falls back to this thread)', async () => {
    const processor = new HistoricalTickProcessor(makeConfig(), {} as Queue);
    await processor.onModuleInit();
    const firstThread = lastThread;

    const job = { data: { symbol: 'XAUUSD', brokerSymbol: null, server: null, feedId: null, ticks: [] } } as Job;
    const processPromise = (processor as unknown as { process(job: Job): Promise<void> }).process(job);
    await vi.waitFor(() => expect(firstThread.messages).toHaveLength(1));

    firstThread.emit('exit', 1);

    await expect(processPromise).rejects.toThrow('worker_thread exited before replying');
    // Respawn is deliberately backed off (RESPAWN_BACKOFF_MS), not
    // immediate -- see historical-tick.processor.ts's own comment on why a
    // persistently-broken thread must not respawn in a tight CPU-burning
    // loop.
    await vi.waitFor(() => expect(spawnedThreads).toHaveLength(2), { timeout: 2000 });
    expect(spawnedThreads[1]).not.toBe(firstThread);
  });
});
