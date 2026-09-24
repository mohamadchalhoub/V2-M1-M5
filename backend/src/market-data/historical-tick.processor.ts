/**
 * The BullMQ Worker for the `historical-tick-ingestion` queue.
 *
 * STRICT RULE, and the entire reason this file is this thin: no dedup, no
 * JSON.stringify loop, no SQL-array construction, no per-tick work of any
 * kind happens here, on the main API/SAR-serving thread. `process()` below
 * does exactly two things -- `postMessage` to the worker_thread, and await
 * the correlated reply. Every byte of CPU-heavy work lives in
 * historical-tick-worker-thread.ts, on its own V8 isolate and event loop.
 *
 * A plain BullMQ `Worker` callback running the OLD synchronous dedup code
 * directly would NOT have solved the problem this exists to solve -- it
 * would still run on this same main thread, blocking SAR-serving requests
 * exactly as today, just deferred from the HTTP request/response cycle
 * rather than removed. That distinction is the whole point of this file.
 *
 * No main-thread fallback, ever: if the worker thread dies, it is
 * respawned, and the in-flight job is left to fail (attempts: 1,
 * maxStalledCount: 0 -- see jobs.module.ts/jobs.constants.ts) rather than
 * processed here. Historical ingestion may degrade; SAR execution must
 * never become coupled to it again.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker } from 'bullmq';
import { Worker as ThreadWorker } from 'node:worker_threads';
import * as path from 'node:path';
import { HISTORICAL_TICK_QUEUE, HISTORICAL_TICK_QUEUE_NAME } from '../jobs/jobs.constants';
import { createRedisConnection } from '../jobs/redis-connection';
import type { IngestMessage, IngestResult } from './historical-tick-worker.types';

interface HistoricalTickJobData {
  readonly symbol: string;
  readonly brokerSymbol: string | null;
  readonly server: string | null;
  readonly feedId: string | null;
  readonly ticks: IngestMessage['ticks'];
}

const REPLY_TIMEOUT_MS = 30_000;
const RESPAWN_BACKOFF_MS = 1_000;

@Injectable()
export class HistoricalTickProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HistoricalTickProcessor.name);
  private worker?: Worker;
  private thread?: ThreadWorker;
  private shuttingDown = false;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (r: IngestResult) => void; reject: (err: Error) => void }>();

  /** Observable, in-memory only (Phase 1 scope) -- read by a future health/metrics endpoint. */
  public droppedBacklogCount = 0;

  constructor(private readonly config: ConfigService, @Inject(HISTORICAL_TICK_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    this.spawnThread();

    const connection = createRedisConnection(this.config);
    this.worker = new Worker(HISTORICAL_TICK_QUEUE_NAME, (job) => this.process(job), {
      connection,
      concurrency: 2, // matches the worker_thread's own pg.Pool max: 2
      maxStalledCount: 0, // a stalled job (worker died mid-job) is marked failed immediately, never retried -- see jobs.constants.ts's own reasoning
    });
    this.worker.on('error', (err) => {
      this.logger.error(`historical-tick worker error: ${err instanceof Error ? err.message : err}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.shuttingDown = true;
    if (this.thread) {
      const exited = new Promise<void>((resolve) => this.thread!.once('exit', () => resolve()));
      this.thread.postMessage({ shutdown: true });
      // Give the thread's own `pool.end()` a chance to finish gracefully
      // (closing its pg connections cleanly) before force-terminating --
      // otherwise `terminate()` races the in-flight shutdown and the thread
      // exits with a non-zero code that looks like a crash in the logs.
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await this.thread.terminate();
    }
  }

  private spawnThread(): void {
    const entry = path.join(__dirname, 'historical-tick-worker-thread.js');
    this.thread = new ThreadWorker(entry);
    this.thread.on('message', (result: IngestResult) => {
      const waiter = this.pending.get(result.id);
      if (!waiter) return;
      this.pending.delete(result.id);
      waiter.resolve(result);
    });
    this.thread.on('error', (err) => {
      this.logger.error(`historical-tick worker_thread error: ${err.message}`);
    });
    this.thread.on('exit', (code) => {
      if (this.shuttingDown) return; // expected exit as part of onModuleDestroy, not a crash
      this.logger.error(`historical-tick worker_thread exited unexpectedly (code ${code}); respawning`);
      // Reject every in-flight request -- their BullMQ job fails
      // (attempts: 1, no retry) rather than being silently reprocessed or,
      // worse, falling back to this thread.
      for (const [id, waiter] of this.pending) {
        waiter.reject(new Error('worker_thread exited before replying'));
        this.pending.delete(id);
      }
      // Fixed backoff, not immediate respawn -- a thread that cannot start
      // at all (e.g. a persistent DB outage) would otherwise respawn in a
      // tight loop, burning CPU on the exact main thread this whole change
      // exists to protect. RESPAWN_BACKOFF_MS is deliberately short enough
      // that a transient crash recovers quickly, long enough that a
      // permanently-broken thread can't spin.
      setTimeout(() => {
        if (!this.shuttingDown) this.spawnThread();
      }, RESPAWN_BACKOFF_MS);
    });
  }

  private async process(job: Job<HistoricalTickJobData>): Promise<void> {
    const { symbol, brokerSymbol, server, feedId, ticks } = job.data;
    const id = this.nextId++;
    const result = await new Promise<IngestResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`historical-tick worker_thread did not reply within ${REPLY_TIMEOUT_MS}ms`));
      }, REPLY_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timeout);
          resolve(r);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.thread!.postMessage({ id, symbol, brokerSymbol, server, feedId, ticks } satisfies IngestMessage);
    });

    if (!result.ok) {
      throw new Error(result.error ?? 'historical-tick ingestion failed');
    }
  }
}
