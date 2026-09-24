/**
 * Message shapes shared between historical-tick.processor.ts (main thread)
 * and historical-tick-worker-thread.ts (the worker thread) -- deliberately
 * its OWN file with zero side-effecting top-level code, so the main-thread
 * processor can import these types without ever executing the worker
 * thread's own `if (!parentPort) throw` guard, which would otherwise fire
 * immediately on the main thread the instant that module was imported for
 * its types alone.
 */
import type { IncomingTickLike } from './historical-tick-dedup';

export interface IngestMessage {
  readonly id: number;
  readonly symbol: string;
  readonly brokerSymbol: string | null;
  readonly server: string | null;
  readonly feedId: string | null;
  readonly ticks: readonly IncomingTickLike[];
}

export type ShutdownMessage = { readonly shutdown: true };

export interface IngestResult {
  readonly id: number;
  readonly ok: boolean;
  readonly inserted?: number;
  readonly error?: string;
}
