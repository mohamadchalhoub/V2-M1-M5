import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TrendBreakoutInstrumentId } from './instrument-config';

/**
 * §3 — "at most one EURUSD position, one gold position... Use durable
 * request state and concurrency protection. An in-memory check alone must
 * not be presented as sufficient across restarts or multiple workers."
 *
 * The durability/concurrency guarantee comes from Postgres itself: creating
 * a `TrendBreakoutSlotLock` row IS the act of claiming the slot, and its
 * `@@id([accountId, instrument])` primary key makes a second, concurrent
 * claim attempt fail with a unique-constraint violation at the database —
 * this holds across process restarts and across multiple worker processes,
 * not just within one in-memory Set a single Node process happens to hold.
 */
export type SlotState = 'PENDING' | 'OPEN' | 'UNKNOWN';

export class SlotOccupiedError extends Error {
  constructor(instrument: TrendBreakoutInstrumentId) {
    super(`${instrument}'s entry slot is already occupied — refusing to submit another entry until it is confirmed closed and resolved.`);
  }
}

@Injectable()
export class TrendBreakoutSlotLockService {
  private readonly logger = new Logger(TrendBreakoutSlotLockService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** §3's "the instrument's slot is free" check — an open position, a pending order, an in-flight request, or an UNKNOWN outcome all count as occupied, because ALL of them leave a row here regardless of which state they're in. */
  async isOccupied(accountId: string, instrument: TrendBreakoutInstrumentId): Promise<boolean> {
    const row = await this.prisma.trendBreakoutSlotLock.findUnique({ where: { accountId_instrument: { accountId, instrument } } });
    return row !== null;
  }

  /**
   * Atomically claims the slot for a newly-created decision. Throws
   * `SlotOccupiedError` if the slot is already held by anyone — including a
   * genuinely concurrent caller that raced this same check, which is
   * exactly the scenario a plain in-memory check cannot protect against.
   */
  async claim(accountId: string, instrument: TrendBreakoutInstrumentId, decisionId: string, state: SlotState = 'PENDING'): Promise<void> {
    try {
      await this.prisma.trendBreakoutSlotLock.create({ data: { accountId, instrument, decisionId, state } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new SlotOccupiedError(instrument);
      }
      throw err;
    }
  }

  /** Moves a claimed slot between PENDING/OPEN/UNKNOWN as broker confirmation arrives — never releases it (only `release` does that, and only once closure is CONFIRMED). */
  async updateState(accountId: string, instrument: TrendBreakoutInstrumentId, state: SlotState): Promise<void> {
    await this.prisma.trendBreakoutSlotLock.update({ where: { accountId_instrument: { accountId, instrument } }, data: { state } });
  }

  /**
   * Releases the slot — MUST only be called once the position is
   * confirmed closed AND the originating request is fully resolved (§3).
   * Never call this on a merely-pending or unknown-outcome request; that
   * is exactly the premature release this design exists to prevent.
   */
  async release(accountId: string, instrument: TrendBreakoutInstrumentId): Promise<void> {
    await this.prisma.trendBreakoutSlotLock.delete({ where: { accountId_instrument: { accountId, instrument } } });
    this.logger.log(`released ${instrument} slot for account ${accountId} — confirmed closed and resolved`);
  }

  async getLock(accountId: string, instrument: TrendBreakoutInstrumentId) {
    return this.prisma.trendBreakoutSlotLock.findUnique({ where: { accountId_instrument: { accountId, instrument } } });
  }
}
