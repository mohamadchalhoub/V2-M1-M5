/**
 * Periodic, restart-safe invocation of the gold watch cycle — the piece
 * `gold-execution-watch.ts` (a manually-invoked single cycle) deliberately
 * did not provide, matching every other coordinator in this codebase's own
 * "built and tested ahead of its own scheduler" posture, but which the
 * task explicitly requires be built once that posture has been reviewed
 * and an explicit decision made to run continuously.
 *
 * Reuses `ProcessLock` from v1's own `watch.ts` (single-instance enforcement
 * — a lock held for the whole process lifetime, not per cycle) rather than
 * re-implementing it. Never crashes the loop on a single cycle's error —
 * every cycle is wrapped and logged; the interval keeps running.
 *
 * Kill switch and STOP NEW ENTRIES are NOT re-checked here separately —
 * they are already checked, fresh, on every call inside
 * `GoldExecutionCoordinatorService.evaluate()` (kill switch) and re-checked
 * immediately before every queue-send (STOP NEW ENTRIES) — this scheduler
 * only decides WHEN to run a cycle, never whether an individual decision
 * is allowed to proceed, so there is exactly one place either switch is
 * enforced, not two copies that could drift.
 */
import { ProcessLock } from '../research/confirmed-retest/watch';

export interface GoldSchedulerCycleResult {
  actionableEventCount: number;
  /** Live-quote-detected touches this cycle — the primary detection path (see gold-live-touch.ts). Optional so a caller not yet passing it (e.g. a simplified test double) still type-checks. */
  liveTouchEventCount?: number;
  liveTouchQueuedCount?: number;
}

export interface GoldSchedulerDeps {
  runCycle: () => Promise<GoldSchedulerCycleResult>;
  intervalMs: number;
  lock: ProcessLock;
  onCycleError?: (err: unknown) => void;
  onCycleResult?: (result: GoldSchedulerCycleResult) => void;
}

export class GoldExecutionScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running = false;

  constructor(private readonly deps: GoldSchedulerDeps) {}

  start(): void {
    if (this.timer) return; // already started — idempotent, never double-schedules
    const nowT = Date.now();
    this.deps.lock.acquire(nowT);
    this.timer = setInterval(() => this.runOneCycleSafely(), this.deps.intervalMs);
    // Fire one cycle immediately too, rather than waiting a full interval for the first observation.
    void this.runOneCycleSafely();
  }

  private async runOneCycleSafely(): Promise<void> {
    if (this.stopped || this.running) return; // never overlap two cycles if one runs long
    this.running = true;
    try {
      this.deps.lock.heartbeat(Date.now());
      const result = await this.deps.runCycle();
      this.deps.onCycleResult?.(result);
    } catch (err) {
      this.deps.onCycleError?.(err);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.deps.lock.release();
  }
}
