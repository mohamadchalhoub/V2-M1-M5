/**
 * The collector-facing poll/report contract for
 * `xauusd-m1-rsi-retest-extremes-v1`.
 *
 * Its OWN route, deliberately not a symbol parameter on a shared one, so the
 * retired strategies' wire contracts and this one can never be confused at
 * the HTTP layer — the same isolation posture the previous strategies used
 * for the same reason.
 *
 * Close-request and protection-restore polling are NOT duplicated here: those
 * already exist on the gold-execution route, operate on ticket-scoped rows,
 * and are reused unchanged (spec §10's "reuse the existing DEMO execution
 * infrastructure"). Only ENTRY submission is new.
 */
import { Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { AccountsService } from '../accounts/accounts.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { RsiDecisionService } from './decision.service';
import { GoldTelegramService } from '../gold-execution/gold-telegram.service';
import { GoldAiSummaryService } from '../gold-execution/gold-ai-summary.service';
import { RSI_DEFAULT_VOLUME_LOTS, RSI_GOLD_POINT_SIZE, rsiMagicForFamily, RSI_SYMBOL } from './safety-constants';

class RsiExecutionResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsInt() ticket?: number;
  @IsOptional() @IsNumber() filledPrice?: number;
  @IsOptional() @IsNumber() brokerStopLoss?: number;
  @IsOptional() @IsNumber() brokerTakeProfit?: number;
  @IsOptional() @IsString() errorMessage?: string;
  /** True when the broker's response was lost/ambiguous — recorded as UNKNOWN, never FAILED. */
  @IsOptional() @IsBoolean() uncertain?: boolean;
}

@Controller('collector/:accountId/xauusd-rsi')
@UseGuards(CollectorTokenGuard)
export class RsiExecutionController {
  private readonly logger = new Logger(RsiExecutionController.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly decisions: RsiDecisionService,
    private readonly telegram: GoldTelegramService,
    /**
     * Informational narration only. Nothing in the execution path or the
     * Telegram path reads it, waits for it, or branches on it — it is invoked
     * fire-and-forget AFTER the outcome has already been durably recorded and
     * reported, so an AI provider being slow, wrong or entirely unavailable
     * cannot affect a single trading decision or a single notification.
     */
    private readonly aiSummary: GoldAiSummaryService,
  ) {}

  @Get('pending-order')
  async getPendingOrder(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const decision = await this.decisions.claimOldestPendingOrder(accountId);
    if (!decision || decision.entryPrice === null || decision.stopLoss === null || decision.takeProfit === null) {
      return { order: null };
    }

    const entryPrice = decision.entryPrice.toNumber();
    const stopLoss = decision.stopLoss.toNumber();
    const takeProfit = decision.takeProfit.toNumber();

    // Final re-verification, after the claim but before the hand-off. The
    // claim only proves nobody else took this row; it says nothing about
    // whether the Friday cutoff, the daily pause, a control, the price or the
    // occupancy are still valid. This row is already SENT, so a failure must
    // explicitly cancel it rather than merely skip it.
    const preSend = await this.decisions.preSendCheck({
      decisionId: decision.id,
      accountId,
      action: decision.direction === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL',
      entryPrice,
      observedAtT: decision.observedAt.getTime(),
      family: decision.ruleFamily,
    });
    if (!preSend.ok) {
      this.logger.warn(`decision ${decision.id}: failed pre-send re-verification, cancelling instead of sending — ${preSend.reason}`);
      await this.decisions.cancelClaimed(decision.id, `Cancelled at pre-send check: ${preSend.reason}`);
      void this.telegram.notify(
        'SUBMISSION_REJECTED',
        `rsi-presend:${decision.id}`,
        `XAUUSD RSI DEMO — ${decision.ruleFamily} ${decision.direction} entry cancelled at the pre-send check and never sent to the broker. decision=${decision.id} reason=${preSend.reason}`,
      );
      return { order: null };
    }

    return {
      order: {
        decisionId: decision.id,
        side: decision.direction,
        // The SAME volume the risk gate approved, read off the row — never a
        // fresh read of runtime settings, which may have changed since.
        volume: decision.volumeLots?.toNumber() ?? RSI_DEFAULT_VOLUME_LOTS,
        // Absolute prices are sent alongside the point distances so the
        // executor can verify rather than re-derive the protective levels.
        entryPrice,
        stopLoss,
        takeProfit,
        stopLossPoints: priceDistanceInPoints(entryPrice, stopLoss),
        takeProfitPoints: priceDistanceInPoints(entryPrice, takeProfit),
        // This FAMILY's own magic number, so the resulting broker ticket is
        // attributable to one execution slot rather than merely to this strategy.
        magic: rsiMagicForFamily(decision.ruleFamily),
        ruleFamily: decision.ruleFamily,
        symbol: RSI_SYMBOL,
        pointSize: RSI_GOLD_POINT_SIZE,
        comment: `rsi-${decision.id.slice(0, 8)}`,
      },
    };
  }

  @Post('pending-order/:decisionId/result')
  async postResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('decisionId', ParseUUIDPipe) decisionId: string,
    @Body() dto: RsiExecutionResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    await this.decisions.recordExecutionResult(decisionId, {
      ok: dto.ok,
      ticket: dto.ticket ?? null,
      filledPrice: dto.filledPrice ?? null,
      brokerStopLoss: dto.brokerStopLoss ?? null,
      brokerTakeProfit: dto.brokerTakeProfit ?? null,
      errorMessage: dto.errorMessage ?? null,
      uncertain: dto.uncertain ?? false,
    });

    // Fire-and-forget: the outcome is already durably recorded above, so a
    // Telegram outage must never fail this endpoint or lose the result.
    if (dto.uncertain) {
      void this.telegram.notify(
        'SUBMISSION_REJECTED',
        `rsi-uncertain:${decisionId}`,
        `XAUUSD RSI DEMO — submission outcome UNKNOWN. decision=${decisionId} error=${dto.errorMessage ?? 'no broker response'}. ` +
          'The order may or may not have reached the broker; it is NOT assumed failed and the position slot stays occupied until reconciled.',
      );
    } else if (dto.ok) {
      const text =
        `XAUUSD RSI DEMO — entry filled (broker-confirmed). decision=${decisionId} ticket=${dto.ticket ?? 'n/a'} ` +
        `filled=${dto.filledPrice ?? 'n/a'} brokerSL=${dto.brokerStopLoss ?? 'n/a'} brokerTP=${dto.brokerTakeProfit ?? 'n/a'}`;
      void this.telegram.notify('FILL_CONFIRMED', `rsi-fill:${decisionId}`, text);
      // Narration is generated from the SAME factual text that was already
      // sent, and only after it was sent.
      void this.aiSummary.generateForEvent('FILL_CONFIRMED', new Date().toISOString(), text);
    } else {
      void this.telegram.notify(
        'SUBMISSION_REJECTED',
        `rsi-reject:${decisionId}`,
        `XAUUSD RSI DEMO — entry rejected by the broker. decision=${decisionId} error=${dto.errorMessage ?? 'unknown'}`,
      );
    }

    return { ok: true };
  }
}

function priceDistanceInPoints(a: number, b: number): number {
  return Math.round((Math.abs(a - b) / RSI_GOLD_POINT_SIZE) * 1e6) / 1e6;
}
