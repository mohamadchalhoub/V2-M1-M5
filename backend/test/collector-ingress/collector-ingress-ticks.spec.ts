/**
 * Focused unit test for `postTicks`'s Phase 1 bounded-backlog behavior --
 * constructs the controller directly with mocked collaborators rather than
 * bootstrapping the whole Nest app, since every other route is unaffected
 * and already has its own coverage elsewhere.
 */
import { describe, expect, it, vi } from 'vitest';
import { CollectorIngressController } from '../../src/collector-ingress/collector-ingress.controller';
import { HISTORICAL_TICK_MAX_BACKLOG } from '../../src/jobs/jobs.constants';

function makeController(waitingCount: number, threadAlive = true) {
  const queue = {
    getWaitingCount: vi.fn().mockResolvedValue(waitingCount),
    add: vi.fn().mockResolvedValue(undefined),
  };
  const processor = { isThreadAlive: vi.fn().mockReturnValue(threadAlive) };
  const controller = new CollectorIngressController(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    queue as any,
    processor as any,
  );
  return { controller, queue, processor };
}

const dto = { symbol: 'XAUUSD', brokerSymbol: 'XAUUSD.a', server: 'Test', feedId: 'f1', ticks: [{ timestamp: '2026-09-24T00:00:00Z', bid: 1, ask: 1.1, flags: 6, batchSeq: 0 }] } as any;

describe('postTicks bounded backlog', () => {
  it('enqueues normally when backlog is below the bound', async () => {
    const { controller, queue } = makeController(0);
    const result = await controller.postTicks(dto);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith('ingest', {
      symbol: 'XAUUSD',
      brokerSymbol: 'XAUUSD.a',
      server: 'Test',
      feedId: 'f1',
      ticks: dto.ticks,
    });
    expect(result).toEqual({ ok: true, queued: true });
  });

  it('drops and reports ok without enqueueing when backlog is at the bound', async () => {
    const { controller, queue } = makeController(HISTORICAL_TICK_MAX_BACKLOG);
    const result = await controller.postTicks(dto);
    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, inserted: 0, dropped: true });
  });

  it('drops when backlog exceeds the bound', async () => {
    const { controller, queue } = makeController(HISTORICAL_TICK_MAX_BACKLOG + 50);
    const result = await controller.postTicks(dto);
    expect(queue.add).not.toHaveBeenCalled();
    expect(result.dropped).toBe(true);
  });

  it('enqueues right up to bound - 1', async () => {
    const { controller, queue } = makeController(HISTORICAL_TICK_MAX_BACKLOG - 1);
    const result = await controller.postTicks(dto);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, queued: true });
  });
});

describe('GET /collector/ticks/health', () => {
  it('reports worker liveness, current backlog, the configured bound, and dropped-batch count', async () => {
    const { controller } = makeController(5, true);
    const health = await controller.getTicksHealth();
    expect(health).toEqual({
      workerThreadAlive: true,
      waitingBacklog: 5,
      backlogBound: HISTORICAL_TICK_MAX_BACKLOG,
      droppedBatchesSinceRestart: 0,
    });
  });

  it('reflects a dead worker thread', async () => {
    const { controller } = makeController(0, false);
    const health = await controller.getTicksHealth();
    expect(health.workerThreadAlive).toBe(false);
  });

  it('reflects dropped batches after a drop occurs', async () => {
    const { controller } = makeController(HISTORICAL_TICK_MAX_BACKLOG);
    await controller.postTicks(dto);
    const health = await controller.getTicksHealth();
    expect(health.droppedBatchesSinceRestart).toBe(1);
  });
});
