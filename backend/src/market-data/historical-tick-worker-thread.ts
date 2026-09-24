/**
 * The historical-tick ingestion worker_thread.
 *
 * Every byte of CPU-heavy work here (dedup + SQL construction) runs on this
 * thread's OWN V8 isolate and OWN event loop -- it cannot block, and cannot
 * be blocked by, the main API process's event loop, which is what serves
 * xauusd-sar-v1's execution-critical routes. This is the isolation Phase 1
 * exists to provide (see historical-tick.processor.ts for why a plain
 * BullMQ Worker callback on the main thread would NOT have achieved this).
 *
 * Deliberately does NOT use Prisma. `HistoricalTickService.upsertTicks()`
 * already bypasses Prisma's query builder for this exact operation (a raw
 * `$executeRaw` INSERT) -- there is no ORM feature in use to justify a
 * second PrismaClient here, which would load a second copy of Prisma's
 * native query-engine binary into memory and open a second,
 * default-formula-sized connection pool. A plain `pg.Pool`, capped at 1
 * connection (the BullMQ Worker's own concurrency is 1 -- see
 * historical-tick.processor.ts -- so at most one query is ever in flight
 * from this thread), is the smaller, more honest choice for a single
 * parameterized INSERT statement.
 */
import { parentPort } from 'node:worker_threads';
import { Pool } from 'pg';
import { buildTickInsert, dedupeTicks } from './historical-tick-dedup';
import type { IngestMessage, IngestResult, ShutdownMessage } from './historical-tick-worker.types';

if (!parentPort) {
  throw new Error('historical-tick-worker-thread.ts must be run as a worker_thread, not imported directly.');
}

// Capped at 1 -- see this file's own docstring. Never the Prisma-style
// formula-sized default; the BullMQ Worker feeding this thread runs at
// concurrency:1, so a single connection is always sufficient.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

parentPort.on('message', (msg: IngestMessage | ShutdownMessage) => {
  if ('shutdown' in msg) {
    void pool.end();
    return;
  }
  void handleIngest(msg);
});

async function handleIngest(msg: IngestMessage): Promise<void> {
  try {
    const deduped = dedupeTicks(msg.ticks);
    if (deduped.length === 0) {
      reply({ id: msg.id, ok: true, inserted: 0 });
      return;
    }
    const { text, values } = buildTickInsert(msg.symbol, msg.brokerSymbol, msg.server, msg.feedId, deduped);
    const result = await pool.query(text, values);
    reply({ id: msg.id, ok: true, inserted: result.rowCount ?? 0 });
  } catch (err) {
    reply({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function reply(result: IngestResult): void {
  parentPort!.postMessage(result);
}
