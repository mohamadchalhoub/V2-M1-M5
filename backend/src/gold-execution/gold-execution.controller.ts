import { Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { AccountsService } from '../accounts/accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { AutonomousDecisionLoggerService } from '../autonomous/autonomous-decision-logger.service';
import { ExecutionResultDto } from '../autonomous/dto/execution-result.dto';
import { GoldPreSendGuardService } from './gold-pre-send-guard.service';
import { GoldTelegramService } from './gold-telegram.service';
import { GoldAiSummaryService } from './gold-ai-summary.service';
import { GoldCloseExecutionService } from './gold-close-execution.service';
import { GoldProtectionRestoreService } from './gold-protection-restore.service';
import { GOLD_MAGIC_NUMBER, GOLD_POINT_SIZE, GOLD_SYMBOL, GOLD_VOLUME_LOTS } from './gold-safety-constants';

/** What the collector reports back after attempting a claimed close request (runner.py's OrderResult, over the wire). */
class GoldCloseResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsInt() dealTicket?: number;
  @IsOptional() @IsNumber() closedPrice?: number;
  @IsOptional() @IsString() errorMessage?: string;
}

/** What the collector reports back after attempting a claimed protection-restore request (runner.py's OrderResult, over the wire). */
class GoldRestoreResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsString() errorMessage?: string;
}

/**
 * Gold's OWN collector-facing poll/report route — deliberately separate
 * from AutonomousExecutionController (EURUSD), not a symbol parameter on
 * the same route, so the two strategies' wire contracts can never be
 * confused at the HTTP layer either. Shares the same underlying
 * AutonomousDecision table/logger (symbol='XAUUSD' rows) and the same
 * CollectorTokenGuard/account-scoped URL convention as every other
 * collector-facing route, but claims and serves ONLY XAUUSD rows
 * (see the required `symbol` argument added to `claimOldestPendingOrder`).
 */
@Controller('collector/:accountId/gold-execution')
@UseGuards(CollectorTokenGuard)
export class GoldExecutionController {
  private readonly preSendLogger = new Logger(GoldExecutionController.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly logger: AutonomousDecisionLoggerService,
    private readonly preSendGuard: GoldPreSendGuardService,
    private readonly goldTelegram: GoldTelegramService,
    private readonly goldAiSummary: GoldAiSummaryService,
    private readonly closeExecution: GoldCloseExecutionService,
    private readonly protectionRestore: GoldProtectionRestoreService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * DISABLED as of the migration to `xauusd-m1-rsi-retest-extremes-v1`.
   *
   * This route was the retired H4 confirmed-retest strategy's only path to
   * the broker. It now always returns `{ order: null }` WITHOUT claiming
   * anything, so that:
   *
   *   - no pre-existing queued row from that strategy can ever be sent, even
   *     if one is still sitting PENDING in the database (they are retired
   *     with an audit reason by the migration script, but this route must not
   *     depend on that having run);
   *   - a collector still configured with `GOLD_EXECUTION_ENABLED=true`
   *     degrades to a harmless no-op instead of resurrecting the old
   *     strategy;
   *   - the close-request and protection-restore routes below keep working,
   *     because positions that strategy already opened must retain their
   *     protective management until they resolve.
   *
   * The active strategy has its own route: `/collector/:accountId/xauusd-rsi`.
   */
  @Get('pending-order')
  async getPendingOrder(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    this.preSendLogger.warn(
      `gold pending-order poll for account ${accountId} refused: the H4 confirmed-retest strategy is retired and can no longer submit entries. ` +
        'The active strategy polls /collector/:accountId/xauusd-rsi. Set GOLD_EXECUTION_ENABLED=false in the collector to stop this poll.',
    );
    return { order: null };
  }

  /** @deprecated Retired with the strategy; retained only so its shape stays documented. */
  private async retiredGetPendingOrder(accountId: string) {
    const decision = await this.logger.claimOldestPendingOrder(accountId, GOLD_SYMBOL);
    if (!decision || decision.entryPrice === null || decision.stopLoss === null || decision.takeProfit === null) {
      return { order: null };
    }

    const entryPrice = decision.entryPrice.toNumber();
    const stopLoss = decision.stopLoss.toNumber();
    const takeProfit = decision.takeProfit.toNumber();

    // Final re-verification, immediately before handing off to the collector — the atomic claim
    // above only proves nobody else claimed this row; it says nothing about whether window,
    // kill switch, price deviation, or occupancy are STILL valid after however long this row sat
    // PENDING plus the collector's own poll delay. This decision is already SENT at this point
    // (the claim flipped it), so a failure here must explicitly cancel it, not just skip it.
    const touchEndT = extractTouchEndT(decision.inputSnapshot);
    const preSend = await this.preSendGuard.check({
      decisionId: decision.id,
      accountId,
      action: decision.action === 'OPEN_BUY' ? 'OPEN_BUY' : 'OPEN_SELL',
      entryPrice,
      touchEndT,
    });
    if (!preSend.ok) {
      this.preSendLogger.warn(`gold decision ${decision.id}: failed pre-send re-verification, cancelling instead of sending — ${preSend.reason}`);
      await this.logger.recordExecutionResult(decision.id, { ok: false, errorMessage: `Cancelled at pre-send check: ${preSend.reason}` });
      void this.goldTelegram.notify(
        'SUBMISSION_REJECTED',
        `reject:${decision.id}`,
        `GOLD DEMO — order cancelled at pre-send check (never sent to broker). decision=${decision.id} reason=${preSend.reason}`,
      );
      return { order: null };
    }

    return {
      order: {
        decisionId: decision.id,
        side: decision.action === 'OPEN_BUY' ? 'BUY' : 'SELL',
        // Hardcoded, gold-specific safety constants — re-derived from the
        // already-validated absolute prices using GOLD's own point size,
        // never EURUSD's `priceDistanceInPoints` (which divides by
        // EURUSD_POINT_SIZE and would silently produce a wildly wrong
        // points figure for a $-denominated gold price distance).
        // The SAME volume snapshot the risk gate approved this decision
        // against (persisted on the row at evaluation time, in
        // gold-execution-coordinator.service.ts) — never a fresh read of
        // live runtime settings here, which could have changed since
        // evaluation and would then submit a volume risk was never actually
        // computed against. Falls back to the frozen GOLD_VOLUME_LOTS
        // constant only for a pre-existing row from before this column
        // existed (decision.volumeLots null).
        volume: decision.volumeLots?.toNumber() ?? GOLD_VOLUME_LOTS,
        stopLossPoints: goldPriceDistanceInPoints(entryPrice, stopLoss),
        takeProfitPoints: goldPriceDistanceInPoints(entryPrice, takeProfit),
        magic: GOLD_MAGIC_NUMBER,
        symbol: GOLD_SYMBOL,
        pointSize: GOLD_POINT_SIZE,
        comment: `gold-${decision.id.slice(0, 8)}`,
      },
    };
  }

  @Post('pending-order/:decisionId/result')
  async postResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('decisionId', ParseUUIDPipe) decisionId: string,
    @Body() dto: ExecutionResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    await this.logger.recordExecutionResult(decisionId, dto);

    // Broker-confirmed fill, or a rejected/unknown submission — plain factual
    // notification, dedup'd on decisionId+result so a duplicate collector
    // report (e.g. a retried POST) never sends twice. Fire-and-forget: a
    // Telegram outage must never fail this endpoint's response to the
    // collector (recordExecutionResult above has already durably persisted
    // the real outcome regardless of whether this notification succeeds).
    if (dto.ok) {
      const text = `GOLD DEMO — order filled. decision=${decisionId} ticket=${dto.ticket ?? 'n/a'} filledPrice=${dto.filledPrice ?? 'n/a'}`;
      void this.goldTelegram.notify('FILL_CONFIRMED', `fill:${decisionId}`, text);
      void this.goldAiSummary.generateForEvent('FILL_CONFIRMED', new Date().toISOString(), text);
    } else {
      const text = `GOLD DEMO — order rejected/failed. decision=${decisionId} error=${dto.errorMessage ?? 'unknown'}`;
      void this.goldTelegram.notify('SUBMISSION_REJECTED', `reject:${decisionId}`, text);
    }

    return { ok: true };
  }

  // --- Close-request poll/report — task item 2. Symmetric to the open pair
  // above but for GoldCloseRequest rows (created by GoldControlsController's
  // requestClose, gold-controls.controller.ts). ---

  @Get('close-request')
  async getCloseRequest(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const request = await this.closeExecution.claimOldestPendingRequest(accountId);
    if (!request) return { request: null };

    return {
      request: {
        requestId: request.id,
        ticket: Number(request.positionTicket),
        side: request.side,
        volume: request.volume.toNumber(),
        symbol: request.symbol,
      },
    };
  }

  @Post('close-request/:requestId/result')
  async postCloseResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: GoldCloseResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    await this.closeExecution.recordResult(requestId, {
      ok: dto.ok,
      dealTicket: dto.dealTicket ?? null,
      closedPrice: dto.closedPrice ?? null,
      errorMessage: dto.errorMessage ?? null,
    });

    // "closed" is reported ONLY here, ONLY when dto.ok is a broker-confirmed
    // success from executor.py's close_position — never at request-creation
    // time (gold-controls.controller.ts's CLOSE_REQUESTED notification is
    // explicitly a different, earlier, "request sent" event).
    if (dto.ok) {
      void this.goldTelegram.notify(
        'CLOSE_CONFIRMED',
        `close-confirmed:${requestId}`,
        `GOLD DEMO — position closed (broker-confirmed). request=${requestId} dealTicket=${dto.dealTicket ?? 'n/a'} closedPrice=${dto.closedPrice ?? 'n/a'}`,
      );
    } else {
      void this.goldTelegram.notify(
        'CLOSE_FAILED',
        `close-failed:${requestId}`,
        `GOLD DEMO — close request FAILED at the broker. request=${requestId} error=${dto.errorMessage ?? 'unknown'}. Position may still be open — verify manually.`,
      );
    }

    return { ok: true };
  }

  // --- Protection-restore poll/report — task item 3 ("restore-then-close",
  // the RESTORE half). Symmetric to the close-request pair above. ---

  @Get('restore-protection-request')
  async getRestoreProtectionRequest(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const request = await this.protectionRestore.claimOldestPendingRequest(accountId);
    if (!request) return { request: null };

    return {
      request: {
        requestId: request.id,
        ticket: Number(request.positionTicket),
        side: request.side,
        stopLoss: request.stopLoss.toNumber(),
        takeProfit: request.takeProfit.toNumber(),
        symbol: request.symbol,
        attemptNumber: request.attemptNumber,
        maxAttempts: request.maxAttempts,
      },
    };
  }

  /**
   * Records the ONE restore attempt's outcome only — this endpoint
   * deliberately does NOT decide whether to close. The collector's own
   * `ok`/error report only proves what that single order_send call
   * returned; it does not prove the position's actual current SL/TP. The
   * real decision (restored vs. still needs closing) is made separately by
   * `GoldProtectionMonitorService.checkOne` on the NEXT snapshot cycle,
   * reconciling against the position's real broker-reported stopLoss/
   * takeProfit — genuine reconciliation, not a branch on this response.
   */
  @Post('restore-protection-request/:requestId/result')
  async postRestoreProtectionResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: GoldRestoreResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    const request = await this.prisma.goldProtectionRestoreRequest.findUnique({ where: { id: requestId } });
    await this.protectionRestore.recordResult(requestId, { ok: dto.ok, errorMessage: dto.errorMessage ?? null });

    void this.goldTelegram.notify(
      dto.ok ? 'PROTECTION_RESTORE_ATTEMPT_REPORTED_OK' : 'PROTECTION_RESTORE_ATTEMPT_REPORTED_FAILED',
      `protection-restore-attempt:${requestId}`,
      dto.ok
        ? `GOLD DEMO — protection restore attempt reported success by the broker. request=${requestId} position=${request?.positionTicket ?? 'n/a'} stopLoss=${request?.stopLoss.toNumber() ?? 'n/a'} takeProfit=${request?.takeProfit.toNumber() ?? 'n/a'}. Awaiting reconciliation against the next real position snapshot before this is treated as resolved.`
        : `GOLD DEMO — protection restore attempt reported failure/ambiguous result. request=${requestId} position=${request?.positionTicket ?? 'n/a'} error=${dto.errorMessage ?? 'unknown'}. No retry queued — the next snapshot's reconciliation will decide whether to close.`,
    );

    return { ok: true };
  }
}

function goldPriceDistanceInPoints(priceA: number, priceB: number): number {
  return Math.round((Math.abs(priceA - priceB) / GOLD_POINT_SIZE) * 1e6) / 1e6;
}

/**
 * `inputSnapshot` is this coordinator's own JSON, shaped by
 * `GoldExecutionCoordinatorService.evaluate()`'s `inputSnapshot = { signal, context, mode, ... }`
 * — `signal.touchEndT` is always present on a genuinely-queued decision.
 * Returns null (never a guessed fallback) for anything else, so the guard
 * fails closed rather than assume freshness it cannot actually verify.
 */
function extractTouchEndT(inputSnapshot: unknown): number | null {
  if (typeof inputSnapshot !== 'object' || inputSnapshot === null) return null;
  const signal = (inputSnapshot as Record<string, unknown>).signal;
  if (typeof signal !== 'object' || signal === null) return null;
  const touchEndT = (signal as Record<string, unknown>).touchEndT;
  return typeof touchEndT === 'number' && Number.isFinite(touchEndT) ? touchEndT : null;
}
