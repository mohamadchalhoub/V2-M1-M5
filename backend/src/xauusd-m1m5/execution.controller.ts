/**
 * The collector-facing contract for `xauusd-m1-m5-rsi-threshold-v2`.
 *
 * Its OWN route prefix, deliberately not a parameter on a shared one. Two bots
 * on this host trade the same symbol on the same broker, so a wire contract
 * that could be confused at the HTTP layer is a wire contract that eventually
 * will be. `collector/:accountId/xauusd-m1m5/...` cannot be reached by another
 * strategy's collector even by accident.
 *
 * Three endpoints, and nothing else:
 *
 *   POST mt5-snapshot                       what the terminal reports it may do
 *   GET  pending-order                      claim the next order to place
 *   POST pending-order/:id/result           what the broker actually did
 *   GET  close-request                      claim the next position to close
 *   POST close-request/:id/result           whether the broker accepted it
 *   GET  protection-request                 claim the next stop loss to restore
 *   POST protection-request/:id/result      whether the broker accepted it
 *
 * ## Nothing here approves a trade
 *
 * §8 forbids per-trade approval by a human, by AI, by Telegram or by the
 * dashboard. This controller has no approval path and no hook for one. The
 * strategy decided before the row was queued; these endpoints move an already
 * approved order to the terminal and bring the answer back.
 */
import { Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsISO8601, IsNumber, IsOptional, IsString } from 'class-validator';
import { AccountsService } from '../accounts/accounts.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { M1M5CloseRequestService } from './close-request.service';
import { M1M5DecisionQueueService } from './decision-queue.service';
import { M1M5ProtectionService } from './protection.service';
import { M1M5Mt5SnapshotService } from './mt5-snapshot.service';
import { M1M5TelegramService } from './telegram.service';
import { filledMessage, rejectedMessage, uncertainMessage } from './telegram-messages';
import { V2_EXPECTED_GOLD_POINT_SIZE, V2_SYMBOL, v2MagicForTimeframe } from './safety-constants';
import type { Timeframe } from './spec';

/**
 * Every permission is optional, and an omitted one is recorded as null rather
 * than defaulted. See `mt5-snapshot.service.ts`: null means "could not read",
 * which is a third state and must survive the wire intact.
 */
class M1M5Mt5SnapshotDto {
  @IsISO8601() capturedAt!: string;
  @IsOptional() @IsString() login?: string | null;
  @IsOptional() @IsString() server?: string | null;
  @IsOptional() @IsString() tradeMode?: string | null;
  @IsOptional() @IsString() marginMode?: string | null;
  @IsOptional() @IsBoolean() terminalConnected?: boolean | null;
  @IsOptional() @IsBoolean() terminalTradeAllowed?: boolean | null;
  @IsOptional() @IsBoolean() terminalTradeApiDisabled?: boolean | null;
  @IsOptional() @IsBoolean() accountTradeAllowed?: boolean | null;
  @IsOptional() @IsBoolean() accountTradeExpert?: boolean | null;
  @IsOptional() @IsBoolean() sessionOpen?: boolean | null;
  @IsOptional() @IsInt() leverage?: number | null;
}

/**
 * `accepted` means the broker took the request, NOT that the position closed.
 * The distinction is the point: section 9.3 establishes closure by re-querying
 * the broker, never by counting accepted requests.
 */
class M1M5CloseResultDto {
  @IsBoolean() accepted!: boolean;
  @IsOptional() @IsString() errorMessage?: string;
}

class M1M5ExecutionResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsInt() ticket?: number;
  @IsOptional() @IsNumber() filledPrice?: number;
  @IsOptional() @IsNumber() brokerStopLoss?: number;
  @IsOptional() @IsNumber() brokerTakeProfit?: number;
  @IsOptional() @IsString() errorMessage?: string;
  /**
   * True when the broker's response was lost or ambiguous. Sent separately
   * from `ok` on purpose: "we do not know" is a real outcome and collapsing it
   * into `ok: false` would free a slot that may hold a live position.
   */
  @IsOptional() @IsBoolean() uncertain?: boolean;
}

@Controller('collector/:accountId/xauusd-m1m5')
@UseGuards(CollectorTokenGuard)
export class M1M5ExecutionController {
  private readonly logger = new Logger(M1M5ExecutionController.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly queue: M1M5DecisionQueueService,
    private readonly snapshots: M1M5Mt5SnapshotService,
    private readonly closeRequests: M1M5CloseRequestService,
    private readonly telegram: M1M5TelegramService,
    private readonly protection: M1M5ProtectionService,
  ) {}

  /**
   * What the terminal reports about its own permission to trade.
   *
   * Posted on the collector's own cadence, not on demand: the execution path
   * must never block waiting for a terminal round-trip, and a snapshot that
   * arrives only when an order is imminent would be useless for noticing that
   * trading has been switched off while nothing was happening.
   */
  @Post('mt5-snapshot')
  async postMt5Snapshot(@Param('accountId', ParseUUIDPipe) accountId: string, @Body() dto: M1M5Mt5SnapshotDto) {
    await this.accounts.getOrThrow(accountId);
    await this.snapshots.record(accountId, {
      capturedAtMs: Date.parse(dto.capturedAt),
      loginId: dto.login ?? null,
      server: dto.server ?? null,
      tradeMode: dto.tradeMode ?? null,
      marginMode: dto.marginMode ?? null,
      terminalConnected: dto.terminalConnected ?? null,
      terminalTradeAllowed: dto.terminalTradeAllowed ?? null,
      terminalTradeApiDisabled: dto.terminalTradeApiDisabled ?? null,
      accountTradeAllowed: dto.accountTradeAllowed ?? null,
      accountTradeExpert: dto.accountTradeExpert ?? null,
      sessionOpen: dto.sessionOpen ?? null,
      leverage: dto.leverage ?? null,
    });
    return { ok: true };
  }

  @Get('pending-order')
  async getPendingOrder(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const decision = await this.queue.claimOldest(accountId, Date.now());
    if (!decision || decision.entryPrice === null || decision.stopLoss === null || decision.takeProfit === null) {
      return { order: null };
    }

    const entryPrice = decision.entryPrice.toNumber();
    const stopLoss = decision.stopLoss.toNumber();
    const takeProfit = decision.takeProfit.toNumber();
    const timeframe = decision.timeframe as Timeframe;

    return {
      order: {
        decisionId: decision.id,
        timeframe,
        side: decision.direction,
        // The volume RISK APPROVED, read off the row — never a fresh read of
        // the runtime setting, which may have been changed since this order
        // was sized and would silently make it a different trade.
        volume: decision.volumeLots?.toNumber() ?? null,
        entryPrice,
        stopLoss,
        takeProfit,
        // Absolute prices AND point distances, so the collector can verify the
        // protective levels rather than re-derive them and disagree.
        stopLossPoints: priceDistanceInPoints(entryPrice, stopLoss),
        takeProfitPoints: priceDistanceInPoints(entryPrice, takeProfit),
        // This TIMEFRAME's own magic number, so a resulting ticket is
        // attributable to one slot rather than merely to this strategy.
        magic: decision.magicNumber ?? v2MagicForTimeframe(timeframe),
        symbol: V2_SYMBOL,
        pointSize: V2_EXPECTED_GOLD_POINT_SIZE,
        comment: `m1m5-${timeframe.toLowerCase()}-${decision.id.slice(0, 8)}`,
      },
    };
  }

  @Post('pending-order/:decisionId/result')
  async postResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('decisionId', ParseUUIDPipe) decisionId: string,
    @Body() dto: M1M5ExecutionResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    const outcome = await this.queue.recordResult(decisionId, {
      ok: dto.ok,
      ticket: dto.ticket === undefined ? null : String(dto.ticket),
      filledPrice: dto.filledPrice ?? null,
      brokerStopLoss: dto.brokerStopLoss ?? null,
      brokerTakeProfit: dto.brokerTakeProfit ?? null,
      errorMessage: dto.errorMessage ?? null,
      uncertain: dto.uncertain ?? false,
    });

    // Fire-and-forget, and only AFTER the outcome is durably recorded above.
    // A Telegram outage must never fail this endpoint or lose the result --
    // the collector would retry the report and could place nothing new until
    // it succeeded.
    if (outcome !== 'IGNORED_UNCLAIMED') {
      void this.announce(decisionId, outcome, dto);
    }
    return { ok: true, outcome };
  }

  /**
   * The next position this strategy wants closed.
   *
   * Every row is already scoped to a ticket this application owns by magic
   * number -- the ownership decision was made when the row was written, and is
   * recorded on it. There is deliberately no way for the collector to ask
   * "close everything": another bot trades the same symbol on this broker.
   */
  @Get('close-request')
  async getCloseRequest(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const request = await this.closeRequests.claimOldest(accountId);
    if (!request) return { request: null };

    return {
      request: {
        requestId: request.id,
        // A string, because MT5 tickets exceed 2^53 and a numeric round-trip
        // through JSON would silently corrupt them.
        ticket: request.ticket,
        kind: request.kind,
        timeframe: request.timeframe,
        magic: request.magicNumber,
        volume: Number(request.volume),
        reason: request.reason,
        symbol: V2_SYMBOL,
      },
    };
  }

  @Post('close-request/:requestId/result')
  async postCloseResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: M1M5CloseResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    await this.closeRequests.recordResult(requestId, {
      accepted: dto.accepted,
      errorMessage: dto.errorMessage ?? null,
    });
    return { ok: true };
  }

  /**
   * The next position whose protective levels need restoring.
   *
   * A separate route from `close-request` for the same reason it is a separate
   * table: repairing a position and closing one must not be one code path with
   * a branch, because the failure mode of getting that branch wrong is an
   * unintended exit.
   */
  @Get('protection-request')
  async getProtectionRequest(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const request = await this.protection.claimOldest(accountId);
    if (!request) return { request: null };

    return {
      request: {
        requestId: request.id,
        ticket: request.ticket,
        timeframe: request.timeframe,
        magic: request.magicNumber,
        // The levels from the decision that OPENED this position, never
        // recomputed from the current price -- that would silently change the
        // risk the trade was sized for.
        stopLoss: Number(request.stopLoss),
        takeProfit: Number(request.takeProfit),
        missing: request.missing,
        symbol: V2_SYMBOL,
      },
    };
  }

  @Post('protection-request/:requestId/result')
  async postProtectionResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: M1M5CloseResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    await this.protection.recordResult(requestId, {
      accepted: dto.accepted,
      errorMessage: dto.errorMessage ?? null,
    });
    return { ok: true };
  }

  /**
   * Narrates an already-recorded outcome. Never awaited by the request path.
   *
   * Reads the row back rather than trusting the DTO for the trade's own terms:
   * the volume and requested price are what RISK approved, and quoting the
   * collector's echo of them would make a disagreement between the two
   * invisible in exactly the message an operator would use to check.
   */
  private async announce(
    decisionId: string,
    outcome: string,
    dto: M1M5ExecutionResultDto,
  ): Promise<void> {
    try {
      const row = await this.queue.findDecision(decisionId);
      if (!row) return;
      const ctx = { accountLabel: `DEMO ${row.accountId ?? 'unknown'}` };
      const timeframe = row.timeframe as Timeframe;
      const direction = row.direction as 'BUY' | 'SELL';

      if (outcome === 'UNKNOWN') {
        await this.telegram.notify(
          'SUBMISSION_UNCERTAIN',
          `m1m5-uncertain:${decisionId}`,
          uncertainMessage(ctx, {
            timeframe,
            direction,
            detail: dto.errorMessage ?? 'no broker response',
          }),
        );
      } else if (outcome === 'FILLED') {
        await this.telegram.notify(
          'FILL_CONFIRMED',
          `m1m5-fill:${decisionId}`,
          filledMessage(ctx, {
            timeframe,
            direction,
            ticket: dto.ticket === undefined ? 'n/a' : String(dto.ticket),
            volumeLots: row.volumeLots ? row.volumeLots.toNumber() : 0,
            requestedPrice: row.entryPrice ? row.entryPrice.toNumber() : 0,
            fillPrice: dto.filledPrice ?? 0,
            brokerStopLoss: dto.brokerStopLoss ?? null,
            brokerTakeProfit: dto.brokerTakeProfit ?? null,
          }),
        );
      } else if (outcome === 'FAILED') {
        await this.telegram.notify(
          'SUBMISSION_REJECTED',
          `m1m5-reject:${decisionId}`,
          rejectedMessage(ctx, {
            timeframe,
            direction,
            origin: 'BROKER',
            detail: dto.errorMessage ?? 'the broker refused the order without a reason',
          }),
        );
      }
    } catch (err) {
      this.logger.error(`failed to announce ${decisionId}: ${(err as Error).message}`);
    }
  }
}

function priceDistanceInPoints(a: number, b: number): number {
  return Math.round((Math.abs(a - b) / V2_EXPECTED_GOLD_POINT_SIZE) * 1e6) / 1e6;
}
