/**
 * Resuming a signal that is waiting for the market to come back to its
 * published entry.
 *
 * A signal is parked here (`outcome: 'TELEGRAM_AWAITING_ENTRY_RETRACE'`)
 * rather than refused outright when, at the moment it was read, price had
 * already moved favourably off the published entry. The operator's rule is
 * explicit: do not chase a better price, and do not give up either — wait,
 * and there are exactly two ways out:
 *
 *   1. Price retraces back to the published entry (or beyond, adversely, up
 *      to the configured bound) -> the leg is opened THERE, not at the price
 *      first seen.
 *   2. Price reaches the first target (TP1) before retracing -> the signal
 *      is cancelled outright. The move it described has already happened
 *      without it, and it is not taken at a worse level than published.
 *
 * Both are bounded by the signal's own publication-to-submission lifetime
 * (`TELEGRAM_SPEC.maxSignalAgeMs`): a signal that ages out while still
 * waiting expires exactly as any other signal would.
 *
 * This is deliberately a separate sweep from `TelegramTp1WatchService`. That
 * one only ever sets a boolean latch; this one can place a real order, so it
 * needs the full execution context (quote, broker terms, account state,
 * margin) that a latch never required.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { M1M5Mt5SnapshotService } from '../xauusd-m1m5/mt5-snapshot.service';
import { buildTelegramExecutionContext } from './execution-context';
import { TelegramEngineExecutionService } from './execution.service';

export interface EntryRetraceSweepResult {
  readonly examined: number;
  readonly resolved: number;
  readonly detail: string;
}

@Injectable()
export class TelegramEntryRetraceWatchService {
  private readonly logger = new Logger(TelegramEntryRetraceWatchService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly snapshots: M1M5Mt5SnapshotService,
    private readonly execution: TelegramEngineExecutionService,
  ) {}

  async sweep(accountId: string, nowMs: number, expectedLoginId: string | null): Promise<EntryRetraceSweepResult> {
    const waiting = await this.prisma.telegramSignal.findMany({
      where: { accountId, outcome: 'TELEGRAM_AWAITING_ENTRY_RETRACE' },
      select: { id: true },
    });
    if (waiting.length === 0) {
      return { examined: 0, resolved: 0, detail: 'no signal is awaiting an entry retrace.' };
    }

    // Built once per sweep, not once per signal: every waiting signal is
    // judged against the same instant of the market, exactly as a batch of
    // fresh messages arriving together would be.
    const { context } = await buildTelegramExecutionContext({
      prisma: this.prisma,
      snapshots: this.snapshots,
      accountId,
      nowMs,
      expectedLoginId,
    });

    let resolved = 0;
    for (const signal of waiting) {
      try {
        const result = await this.execution.retryAwaitingEntry(signal.id, context);
        if (result !== null) {
          resolved += 1;
          this.logger.log(`telegram signal ${signal.id} awaiting entry retrace resolved: ${result.outcome}`);
        }
      } catch (err) {
        this.logger.warn(`entry-retrace retry failed for signal ${signal.id}: ${(err as Error).message}`);
      }
    }

    return {
      examined: waiting.length,
      resolved,
      detail: `examined ${waiting.length} signal(s) awaiting entry retrace; resolved ${resolved}.`,
    };
  }
}
