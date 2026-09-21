import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { priceDistanceInPoints } from '../technical-analysis/point-value';
import { AutonomousDecisionLoggerService } from './autonomous-decision-logger.service';
import { ExecutionResultDto } from './dto/execution-result.dto';
import { AUTONOMOUS_MAGIC_NUMBER, MAX_POSITION_SIZE_LOTS } from './safety-constants';

/**
 * Phase 6 — the ONLY reverse-direction (backend→collector) route in this
 * project; every other collector-ingress endpoint is a one-way push. The
 * collector polls `GET .../pending-order` on its own interval (no
 * scheduler on the backend side pushes anything) and reports back via
 * `POST .../pending-order/:decisionId/result`. Same `CollectorTokenGuard`
 * and per-account URL convention every other collector-facing route in
 * this codebase already uses.
 */
@Controller('collector/:accountId/autonomous')
@UseGuards(CollectorTokenGuard)
export class AutonomousExecutionController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly logger: AutonomousDecisionLoggerService,
  ) {}

  @Get('pending-order')
  async getPendingOrder(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const decision = await this.logger.claimOldestPendingOrder(accountId, 'EURUSD');
    if (!decision || decision.entryPrice === null || decision.stopLoss === null || decision.takeProfit === null) {
      return { order: null };
    }

    const entryPrice = decision.entryPrice.toNumber();
    const stopLoss = decision.stopLoss.toNumber();
    const takeProfit = decision.takeProfit.toNumber();

    return {
      order: {
        decisionId: decision.id,
        side: decision.action === 'OPEN_BUY' ? 'BUY' : 'SELL',
        // Hardcoded safety constants, never read from the decision row
        // itself — the point distances are RE-DERIVED from the already
        // validated absolute prices (never trusted as a separately-stored
        // number that could drift from them), matching plan §1's "never
        // trust a config value that could be edited" posture for the size.
        volume: MAX_POSITION_SIZE_LOTS,
        stopLossPoints: priceDistanceInPoints(entryPrice, stopLoss),
        takeProfitPoints: priceDistanceInPoints(entryPrice, takeProfit),
        magic: AUTONOMOUS_MAGIC_NUMBER,
        comment: `autonomous-${decision.id.slice(0, 8)}`,
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
    return { ok: true };
  }
}
