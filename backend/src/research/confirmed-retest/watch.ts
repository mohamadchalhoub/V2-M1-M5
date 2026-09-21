/**
 * research/confirmed-retest/watch — watch-only operation (spec §10).
 *
 * HARD BOUNDARY: this module observes stored data and writes local files.
 * It has no order path, imports nothing from any execution code, and never
 * writes to the database (enforced by test/research/confirmed-retest/
 * boundary.spec.ts). "Shadow entry" means a line in a journal.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPaperSimulation, type BalanceScenario, type CostScenario } from './paper';
import type { RunOutputs } from './pipeline';
import type { ReplayState } from './replay';
import { SPEC, SPEC_HASH } from './spec';
import { eventDecisionMatrix, summarizePaper } from './statistics';
import { iso } from './time';
import type { FirstReturnEvent, OutcomeStatus, Units } from './types';

export const ORDER_EXECUTION = 'NONE' as const;

export interface QuoteSnapshot {
  bid: Units;
  ask: Units;
  tickT: number;
  readAtT: number;
}

export type QuoteGateReason =
  | 'PASS'
  | 'QUOTE_UNAVAILABLE'
  | 'QUOTE_STALE_OVER_5S'
  | 'QUOTE_TIMESTAMP_IN_FUTURE_TIME_BASIS_UNVERIFIED'
  | 'SPREAD_OVER_1_USD'
  | 'EXECUTABLE_PRICE_OVER_1_USD_FROM_LEVEL'
  | 'HISTORICAL_BOOTSTRAP_NO_QUOTE';

export interface QuoteGateResult {
  eventId: string;
  pass: boolean;
  reason: QuoteGateReason;
  quote: QuoteSnapshot | null;
  executablePrice: Units | null;
  decidedAtUtc: string;
}

/** Spec §10 shadow-entry gate, evaluated once, at decision time, and then frozen in state. */
export function evaluateQuoteGate(event: FirstReturnEvent, quote: QuoteSnapshot | null, nowT: number): QuoteGateResult {
  const base = { eventId: event.id, quote, decidedAtUtc: new Date(nowT).toISOString() };
  if (!quote) return { ...base, pass: false, reason: 'QUOTE_UNAVAILABLE', executablePrice: null };
  const age = quote.readAtT - quote.tickT;
  if (age < 0) return { ...base, pass: false, reason: 'QUOTE_TIMESTAMP_IN_FUTURE_TIME_BASIS_UNVERIFIED', executablePrice: null };
  if (age > SPEC.shadowQuotes.maxQuoteAgeSeconds * 1000) return { ...base, pass: false, reason: 'QUOTE_STALE_OVER_5S', executablePrice: null };
  if (quote.ask - quote.bid > SPEC.shadowQuotes.maxSpreadUsd * 100) return { ...base, pass: false, reason: 'SPREAD_OVER_1_USD', executablePrice: null };
  const executable = event.direction === 'BUY' ? quote.ask : quote.bid;
  if (Math.abs(executable - event.levelPrice) > SPEC.shadowQuotes.maxExecutableDistanceFromLevelUsd * 100) {
    return { ...base, pass: false, reason: 'EXECUTABLE_PRICE_OVER_1_USD_FROM_LEVEL', executablePrice: executable };
  }
  return { ...base, pass: true, reason: 'PASS', executablePrice: executable };
}

export interface VolumeAuditEntry {
  atUtc: string;
  fromLots: number;
  toLots: number;
  changedBy: string;
}

export interface WatchState {
  strategyVersion: string;
  specHash: string;
  orderExecution: typeof ORDER_EXECUTION;
  createdAtUtc: string;
  bootstrapSettledEndUtc: string | null;
  lastCycleAtUtc: string | null;
  settledEndT: number | null;
  volumeLots: number;
  volumeAudit: VolumeAuditEntry[];
  quoteGate: Record<string, QuoteGateResult>;
  replay: ReplayState | null;
}

export function newWatchState(nowT: number): WatchState {
  return {
    strategyVersion: SPEC.version,
    specHash: SPEC_HASH,
    orderExecution: ORDER_EXECUTION,
    createdAtUtc: new Date(nowT).toISOString(),
    bootstrapSettledEndUtc: null,
    lastCycleAtUtc: null,
    settledEndT: null,
    volumeLots: SPEC.paper.volumeLots,
    volumeAudit: [],
    quoteGate: {},
    replay: null,
  };
}

export class WatchStore {
  readonly statePath: string;
  readonly journalPath: string;
  readonly lockPath: string;
  readonly summaryPath: string;
  readonly processLockPath: string;
  private journalKeys: Set<string> | null = null;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, 'state.json');
    this.journalPath = join(dir, 'journal.jsonl');
    this.lockPath = join(dir, 'watch.lock');
    this.summaryPath = join(dir, 'latest-watch.json');
    this.processLockPath = join(dir, 'watcher.process.lock');
  }

  /**
   * Appends an entry only if no entry with the same key was ever written, so
   * a crash between saving state and journaling can be repaired by simply
   * reconciling again on the next cycle — no duplicates, nothing lost.
   */
  journalOnce(key: string, entry: Record<string, unknown>): boolean {
    if (!this.journalKeys) {
      this.journalKeys = new Set();
      if (existsSync(this.journalPath)) {
        for (const line of readFileSync(this.journalPath, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { key?: string };
            if (parsed.key) this.journalKeys.add(parsed.key);
          } catch {
            // a torn final line from a crash is ignored; its key is re-journaled
          }
        }
      }
    }
    if (this.journalKeys.has(key)) return false;
    this.journal({ key, ...entry });
    this.journalKeys.add(key);
    return true;
  }

  load(nowT: number): WatchState {
    if (!existsSync(this.statePath)) return newWatchState(nowT);
    const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as WatchState;
    if (state.specHash !== SPEC_HASH) {
      throw new Error(`watch state belongs to spec ${state.specHash}; current spec is ${SPEC_HASH}. Refusing to mix rule versions — archive ${this.dir} first.`);
    }
    return state;
  }

  save(state: WatchState): void {
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state));
    if (existsSync(this.statePath)) renameSync(this.statePath, `${this.statePath}.previous`);
    renameSync(tmp, this.statePath);
  }

  journal(entry: Record<string, unknown>): void {
    appendFileSync(this.journalPath, `${JSON.stringify({ atUtc: new Date().toISOString(), specHash: SPEC_HASH, ...entry })}\n`);
  }

  writeSummary(summary: unknown): void {
    const tmp = `${this.summaryPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(summary, null, 2));
    renameSync(tmp, this.summaryPath);
  }

  acquireLock(nowT: number, staleAfterMs = 15 * 60_000): void {
    if (existsSync(this.lockPath)) {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number; atT: number };
      if (nowT - lock.atT < staleAfterMs) throw new Error(`another watch cycle holds ${this.lockPath} (pid ${lock.pid}, ${iso(lock.atT)})`);
    }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, atT: nowT }));
  }

  releaseLock(): void {
    if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
  }
}

export interface ProcessLockInfo {
  pid: number;
  startedAtT: number;
  heartbeatT: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Single-instance lock held for the watcher PROCESS lifetime (not per cycle),
 * so two watchers can never interleave cycles. A lock is only taken over when
 * its owner process is gone or its heartbeat is older than `staleAfterMs`.
 */
export class ProcessLock {
  private owned = false;

  constructor(
    readonly path: string,
    readonly staleAfterMs = 15 * 60_000,
    private readonly isAlive: (pid: number) => boolean = pidAlive,
  ) {}

  read(): ProcessLockInfo | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as ProcessLockInfo;
    } catch {
      return null;
    }
  }

  acquire(nowT: number, pid = process.pid): { tookOverFrom: ProcessLockInfo | null } {
    const existing = this.read();
    if (existing && existing.pid !== pid && this.isAlive(existing.pid) && nowT - existing.heartbeatT < this.staleAfterMs) {
      throw new Error(`another research watcher is running (pid ${existing.pid}, last heartbeat ${iso(existing.heartbeatT)}); refusing to start a second instance`);
    }
    writeFileSync(this.path, JSON.stringify({ pid, startedAtT: nowT, heartbeatT: nowT } satisfies ProcessLockInfo));
    this.owned = true;
    return { tookOverFrom: existing && existing.pid !== pid ? existing : null };
  }

  heartbeat(nowT: number, pid = process.pid): void {
    const current = this.read();
    if (!current || current.pid !== pid) throw new Error('watcher process lock was lost to another process; stopping');
    writeFileSync(this.path, JSON.stringify({ ...current, heartbeatT: nowT }));
  }

  release(pid = process.pid): void {
    const current = this.read();
    if (this.owned && current?.pid === pid && existsSync(this.path)) unlinkSync(this.path);
    this.owned = false;
  }
}

export function setVolume(state: WatchState, toLots: number, changedBy: string, nowT: number): VolumeAuditEntry {
  if (!(toLots > 0) || !changedBy.trim()) throw new Error('--set-volume-lots needs a positive volume and --changed-by <who>');
  const entry = { atUtc: new Date(nowT).toISOString(), fromLots: state.volumeLots, toLots, changedBy: changedBy.trim() };
  state.volumeLots = toLots;
  state.volumeAudit.push(entry);
  return entry;
}

export interface CycleDiff {
  newEvents: FirstReturnEvent[];
  statusChanges: Array<{ eventId: string; from: OutcomeStatus | null; to: OutcomeStatus | null }>;
}

export function diffEvents(before: Record<string, OutcomeStatus | null>, events: FirstReturnEvent[]): CycleDiff {
  const newEvents = events.filter((e) => !(e.id in before));
  const statusChanges = events
    .filter((e) => e.id in before && before[e.id] !== (e.outcome?.status ?? null))
    .map((e) => ({ eventId: e.id, from: before[e.id], to: e.outcome?.status ?? null }));
  return { newEvents, statusChanges };
}

/** Shadow track: forward (observed) events only, quote-gated, with the audited volume. */
export function shadowSimulations(run: RunOutputs, state: WatchState) {
  const forward = run.events.filter((e) => e.observedAtT !== null && e.period === 'STUDY');
  const studyStream = run.build.stream.filter((b) => b.t >= run.studyStartT);
  const costs = SPEC.costScenarios.filter((c) => c.id === 'IDEALIZED_GROSS' || c.id === 'ASSUMED_BASE');
  return SPEC.paper.startingBalances.flatMap((balance) =>
    costs.map((cost) => {
      const result = runPaperSimulation({
        events: forward,
        studyStream,
        studyStartT: run.studyStartT,
        endT: run.endT,
        balance: balance as BalanceScenario,
        cost: cost as CostScenario,
        volumeLots: state.volumeLots,
        entryVeto: (e) => state.quoteGate[e.id]?.pass !== true,
      });
      return { summary: summarizePaper(result), decisions: eventDecisionMatrix(result) };
    }),
  );
}
