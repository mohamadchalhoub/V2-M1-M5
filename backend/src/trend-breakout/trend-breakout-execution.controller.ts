import { Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { AccountsService } from '../accounts/accounts.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { ExecutionResultDto } from '../autonomous/dto/execution-result.dto';
import { resolveInstrumentMappings, TREND_BREAKOUT_INSTRUMENTS, TrendBreakoutInstrumentId } from './instrument-config';
import { TREND_BREAKOUT_FALLBACK_POINT_SIZE, TREND_BREAKOUT_MAGIC_NUMBER } from './execution-constants';
import { TrendBreakoutPreSendGuardService } from './trend-breakout-pre-send-guard.service';
import { TrendBreakoutCloseExecutionService } from './trend-breakout-close-execution.service';
import { TrendBreakoutSlotLockService } from './slot-lock.service';
import { SymbolMetadataService } from './symbol-metadata.service';
import { TrendBreakoutDecisionLoggerService } from './trend-breakout-decision-logger.service';

/** What the collector reports back after attempting a claimed close request (runner.py's OrderResult, over the wire). Same shape as gold's own `GoldCloseResultDto`. */
class TrendBreakoutCloseResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsInt() dealTicket?: number;
  @IsOptional() @IsNumber() closedPrice?: number;
  @IsOptional() @IsString() errorMessage?: string;
}

function isValidInstrument(value: string): value is TrendBreakoutInstrumentId {
  return (TREND_BREAKOUT_INSTRUMENTS as readonly string[]).includes(value);
}

function pointsDistance(priceA: number, priceB: number, pointSize: number): number {
  return Math.round((Math.abs(priceA - priceB) / pointSize) * 1e6) / 1e6;
}

/**
 * Trend-breakout's OWN collector-facing poll/report route — deliberately
 * separate from both `AutonomousExecutionController` (EURUSD legacy) and
 * `GoldExecutionController` (XAUUSD gold), not merged into the existing
 * admin/dashboard `TrendBreakoutController`. `:instrument` is a route
 * parameter (not a query param) so EURUSD's and XAUUSD's polls are two
 * distinct URLs, matching `resolveInstrumentMappings`' own canonical
 * instrument identity — never the raw broker symbol string.
 */
@Controller('collector/:accountId/trend-breakout/:instrument')
@UseGuards(CollectorTokenGuard)
export class TrendBreakoutExecutionController {
  private readonly logger = new Logger(TrendBreakoutExecutionController.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly decisionLogger: TrendBreakoutDecisionLoggerService,
    private readonly preSendGuard: TrendBreakoutPreSendGuardService,
    private readonly closeExecution: TrendBreakoutCloseExecutionService,
    private readonly slotLock: TrendBreakoutSlotLockService,
    private readonly symbolMetadata: SymbolMetadataService,
    private readonly config: ConfigService,
  ) {}

  @Get('pending-order')
  async getPendingOrder(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('instrument') instrumentParam: string,
  ) {
    await this.accounts.getOrThrow(accountId);
    if (!isValidInstrument(instrumentParam)) return { order: null };
    const instrument = instrumentParam;
    const mapping = resolveInstrumentMappings(this.config)[instrument];

    const decision = await this.decisionLogger.claimOldestPendingOrder(accountId, instrument);
    if (!decision || decision.intendedEntryPrice === null || decision.intendedStopLoss === null || decision.intendedTakeProfit === null) {
      return { order: null };
    }

    const entryPrice = decision.intendedEntryPrice.toNumber();
    const stopLoss = decision.intendedStopLoss.toNumber();
    const takeProfit = decision.intendedTakeProfit.toNumber();

    // Final re-verification, immediately before handing off to the collector
    // — this decision is already SENT at this point (the claim flipped it),
    // so a failure here must explicitly cancel it AND release the slot lock,
    // never just skip it and leave the slot stuck occupied.
    const preSend = await this.preSendGuard.check({
      decisionId: decision.id,
      accountId,
      instrument,
      brokerSymbol: mapping.brokerSymbol,
      action: decision.action === 'OPEN_BUY' ? 'OPEN_BUY' : 'OPEN_SELL',
      entryPrice,
      signalCloseAt: decision.signalCloseAt,
    });
    if (!preSend.ok) {
      this.logger.warn(`trend-breakout ${instrument} decision ${decision.id}: failed pre-send re-verification, cancelling instead of sending — ${preSend.reason}`);
      await this.decisionLogger.cancelAtPreSendGuard(decision.id, preSend.reason ?? 'unknown');
      try {
        await this.slotLock.release(accountId, instrument);
      } catch (err) {
        this.logger.warn(`trend-breakout ${instrument} decision ${decision.id}: slot release after pre-send failure failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      return { order: null };
    }

    const metadata = await this.symbolMetadata.get(mapping.brokerSymbol);
    const pointSize = metadata?.point ?? TREND_BREAKOUT_FALLBACK_POINT_SIZE[instrument];

    return {
      order: {
        decisionId: decision.id,
        side: decision.action === 'OPEN_BUY' ? 'BUY' : 'SELL',
        // The SAME volume the risk gate approved this decision against
        // (persisted on the row at evaluation time) — never a fresh read of
        // live volume settings here, which could have changed since
        // evaluation and would then submit a volume risk was never actually
        // computed against.
        volume: decision.volumeUsed?.toNumber() ?? mapping.defaultVolumeLots,
        stopLossPoints: pointsDistance(entryPrice, stopLoss, pointSize),
        takeProfitPoints: pointsDistance(entryPrice, takeProfit, pointSize),
        magic: TREND_BREAKOUT_MAGIC_NUMBER[instrument],
        symbol: mapping.brokerSymbol,
        pointSize,
        comment: `tb-${instrument.toLowerCase()}-${decision.id.slice(0, 8)}`,
      },
    };
  }

  @Post('pending-order/:decisionId/result')
  async postResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('instrument') instrumentParam: string,
    @Param('decisionId', ParseUUIDPipe) decisionId: string,
    @Body() dto: ExecutionResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    await this.decisionLogger.recordExecutionResult(decisionId, dto);

    // Broker-confirmed fill flips the slot to OPEN (it stays claimed, just
    // no longer merely PENDING); a broker rejection/failure releases it —
    // never left stuck PENDING.
    if (isValidInstrument(instrumentParam)) {
      if (dto.ok) {
        try {
          await this.slotLock.updateState(accountId, instrumentParam, 'OPEN');
        } catch (err) {
          this.logger.error(`trend-breakout ${instrumentParam} decision ${decisionId}: failed to flip slot lock to OPEN after a confirmed fill — ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        try {
          await this.slotLock.release(accountId, instrumentParam);
        } catch (err) {
          this.logger.warn(`trend-breakout ${instrumentParam} decision ${decisionId}: slot release after execution failure failed (may already be released) — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return { ok: true };
  }

  // --- Close-request poll/report — symmetric to the open pair above, for
  // `TrendBreakoutCloseRequest` rows created by `TrendBreakoutController`'s
  // close-position endpoint. ---

  @Get('close-request')
  async getCloseRequest(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('instrument') instrumentParam: string,
  ) {
    await this.accounts.getOrThrow(accountId);
    if (!isValidInstrument(instrumentParam)) return { request: null };
    const request = await this.closeExecution.claimOldestPendingRequest(accountId, instrumentParam);
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
    @Param('instrument') _instrumentParam: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: TrendBreakoutCloseResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    await this.closeExecution.recordResult(requestId, {
      ok: dto.ok,
      dealTicket: dto.dealTicket ?? null,
      closedPrice: dto.closedPrice ?? null,
      errorMessage: dto.errorMessage ?? null,
    });
    return { ok: true };
  }
}
