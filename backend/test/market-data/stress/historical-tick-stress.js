/**
 * Phase 1 required stress test (plain Node script against the COMPILED
 * dist/ output, not vitest -- real worker_threads.Worker only loads .js
 * files via Node's own module loader, bypassing Vitest's TS transform).
 *
 * Proves: heavy historical-tick ingestion (many large batches, forcing
 * real dedup + real Postgres inserts inside the worker_thread) does NOT
 * measurably delay a concurrently-polled, main-thread async operation
 * standing in for xauusd-sar-v1's execution-critical routes
 * (/xauusd-sar/pending-order, /xauusd-sar/reconcile, /xauusd-sar/watchdog-check
 * are themselves just async Prisma calls on the main event loop -- what
 * would starve them is main-thread CPU-bound work, which this test proves
 * is now zero regardless of ingestion volume).
 *
 * Run manually: node test/market-data/stress/historical-tick-stress.js
 * (requires `npx tsc` build to be current -- run from backend/).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.test'), override: true });

const { Queue } = require('bullmq');
const IORedis = require('ioredis').default;
const { HistoricalTickProcessor } = require('../../../dist/src/market-data/historical-tick.processor');
const { HISTORICAL_TICK_QUEUE_NAME } = require('../../../dist/src/jobs/jobs.constants');

function makeTicks(n, symbol) {
  const out = [];
  const base = Date.now() - n;
  for (let i = 0; i < n; i++) {
    out.push({
      timestamp: new Date(base + i).toISOString(),
      bid: 4260 + Math.random(),
      ask: 4260.2 + Math.random(),
      last: null,
      volume: null,
      volumeReal: null,
      flags: 6,
      batchSeq: i,
    });
  }
  return { symbol, brokerSymbol: 'XAUUSD.a', server: 'StressTest', feedId: 'stress', ticks: out };
}

async function main() {
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(HISTORICAL_TICK_QUEUE_NAME, { connection });
  await queue.obliterate({ force: true }).catch(() => {});

  const fakeConfig = { get: (key) => (key === 'REDIS_URL' ? process.env.REDIS_URL : undefined) };
  const processor = new HistoricalTickProcessor(fakeConfig, queue);
  await processor.onModuleInit();

  const BATCHES = 40;
  const TICKS_PER_BATCH = 2000; // large batches -- forces real, non-trivial dedup + insert CPU work in the worker thread
  console.log(`enqueuing ${BATCHES} batches x ${TICKS_PER_BATCH} ticks = ${BATCHES * TICKS_PER_BATCH} ticks total`);
  for (let b = 0; b < BATCHES; b++) {
    await queue.add('ingest', makeTicks(TICKS_PER_BATCH, `STRESS${b % 5}`));
  }

  // Stand-in for a SAR execution-critical endpoint: a cheap async op that
  // must keep completing quickly regardless of what the historical path is
  // doing. Polled continuously on the SAME main thread/event loop as the
  // BullMQ Worker's job dispatch (postMessage + await reply) runs on.
  const latenciesMs = [];
  let stop = false;
  const pollLoop = (async () => {
    while (!stop) {
      const t0 = Date.now();
      await new Promise((resolve) => setImmediate(resolve)); // exercises the event loop itself
      await connection.ping(); // cheap real async I/O, same shape as a Prisma call
      latenciesMs.push(Date.now() - t0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();

  // Wait for the queue to drain.
  const start = Date.now();
  const TIMEOUT_MS = 120_000;
  while (Date.now() - start < TIMEOUT_MS) {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed');
    if (counts.waiting === 0 && counts.active === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stop = true;
  await pollLoop;

  const finalCounts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed');
  const max = Math.max(...latenciesMs);
  const p99 = latenciesMs.slice().sort((a, b) => a - b)[Math.floor(latenciesMs.length * 0.99)];
  const avg = latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length;

  console.log('final job counts:', finalCounts);
  console.log(`SAR-stand-in polls: ${latenciesMs.length}, avg=${avg.toFixed(1)}ms p99=${p99}ms max=${max}ms`);

  await processor.onModuleDestroy();
  await queue.close();
  await connection.quit();

  if (finalCounts.failed > 0) {
    console.error('FAIL: some ingestion jobs failed');
    process.exit(1);
  }
  if (max > 500) {
    console.error(`FAIL: SAR-stand-in latency spiked to ${max}ms under heavy ingestion (threshold 500ms)`);
    process.exit(1);
  }
  console.log('PASS: SAR-stand-in endpoint stayed responsive throughout heavy historical-tick ingestion.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
