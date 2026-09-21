import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoldExecutionScheduler } from '../../src/gold-execution/gold-execution-scheduler';

function fakeLock() {
  return {
    acquire: vi.fn(),
    heartbeat: vi.fn(),
    release: vi.fn(),
    read: vi.fn(),
  } as any;
}

describe('GoldExecutionScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires the process lock and runs one cycle immediately on start', async () => {
    const lock = fakeLock();
    const runCycle = vi.fn().mockResolvedValue({ actionableEventCount: 0 });
    const scheduler = new GoldExecutionScheduler({ intervalMs: 60_000, lock, runCycle });

    scheduler.start();
    await vi.waitFor(() => expect(runCycle).toHaveBeenCalledTimes(1));

    expect(lock.acquire).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('runs a new cycle on every interval tick, with a heartbeat each time', async () => {
    const lock = fakeLock();
    const runCycle = vi.fn().mockResolvedValue({ actionableEventCount: 0 });
    const scheduler = new GoldExecutionScheduler({ intervalMs: 1000, lock, runCycle });

    scheduler.start();
    await vi.waitFor(() => expect(runCycle).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(runCycle).toHaveBeenCalledTimes(3); // immediate + 2 ticks
    expect(lock.heartbeat).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it('never overlaps two cycles — a slow cycle is not started again before it finishes', async () => {
    const lock = fakeLock();
    let resolveFirst: () => void = () => {};
    const runCycle = vi.fn().mockImplementationOnce(
      () => new Promise<{ actionableEventCount: number }>((resolve) => { resolveFirst = () => resolve({ actionableEventCount: 0 }); }),
    ).mockResolvedValue({ actionableEventCount: 0 });
    const scheduler = new GoldExecutionScheduler({ intervalMs: 1000, lock, runCycle });

    scheduler.start();
    await vi.waitFor(() => expect(runCycle).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000); // tick fires while first cycle still pending
    expect(runCycle).toHaveBeenCalledTimes(1); // NOT started a second time yet

    resolveFirst();
    await vi.waitFor(() => {}); // let the pending promise settle
    scheduler.stop();
  });

  it('logs a cycle error via onCycleError and keeps running (does not crash the loop)', async () => {
    const lock = fakeLock();
    const onCycleError = vi.fn();
    const runCycle = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ actionableEventCount: 0 });
    const scheduler = new GoldExecutionScheduler({ intervalMs: 1000, lock, runCycle, onCycleError });

    scheduler.start();
    await vi.waitFor(() => expect(onCycleError).toHaveBeenCalledTimes(1));
    expect(onCycleError.mock.calls[0][0]).toBeInstanceOf(Error);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(runCycle).toHaveBeenCalledTimes(2)); // still ticking after the error

    scheduler.stop();
  });

  it('stop() clears the interval and releases the lock — no further cycles run', async () => {
    const lock = fakeLock();
    const runCycle = vi.fn().mockResolvedValue({ actionableEventCount: 0 });
    const scheduler = new GoldExecutionScheduler({ intervalMs: 1000, lock, runCycle });

    scheduler.start();
    await vi.waitFor(() => expect(runCycle).toHaveBeenCalledTimes(1));
    scheduler.stop();
    expect(lock.release).toHaveBeenCalledTimes(1);

    const callsBeforeAdvance = runCycle.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(runCycle).toHaveBeenCalledTimes(callsBeforeAdvance); // no new calls after stop
  });

  it('start() is idempotent — calling it twice does not double-schedule', async () => {
    const lock = fakeLock();
    const runCycle = vi.fn().mockResolvedValue({ actionableEventCount: 0 });
    const scheduler = new GoldExecutionScheduler({ intervalMs: 1000, lock, runCycle });

    scheduler.start();
    scheduler.start();
    await vi.waitFor(() => expect(runCycle).toHaveBeenCalled());
    expect(lock.acquire).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
