import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IncomingPositionDto } from '../collector-ingress/dto/snapshot.dto';
import { GOLD_POINT_SIZE, GOLD_SYMBOL, GOLD_TP_SL_USD } from './gold-safety-constants';
import { isOwnedByThisApplication, ownerForMagic } from '../xauusd-rsi/ownership';
import { GoldTelegramService } from './gold-telegram.service';
import { GoldAiSummaryService } from './gold-ai-summary.service';
import { GoldProtectionRestoreService } from './gold-protection-restore.service';
import { GoldCloseExecutionService } from './gold-close-execution.service';

/**
 * Task item C — protective SL/TP verification against ACTUAL broker
 * position data (not just "was requested"). Runs on every
 * `/collector/snapshot` ingestion cycle (same reconciliation posture as
 * `GoldClosureReconciliationService`, task item B — a plain step on the
 * existing poll cycle, not a queued job), reading `stopLoss`/`takeProfit`
 * straight off the same `IncomingPositionDto` the collector already sends
 * every push. Covers BOTH "unprotected right after a fill" and
 * "previously protected, lost protection later" with one mechanism.
 *
 * MT5 convention: 0 (or absent) means "no stop set" — both null and 0 are
 * treated as unprotected.
 *
 * REMEDIATION (task item 3, corrected a second time) — the agreed policy is
 * exactly: ONE restoration attempt, THEN verify actual broker protection
 * via reconciliation, THEN close if still unprotected. This is a state
 * machine driven entirely by the most recent `GoldTelegramNotification`
 * row for this position (Postgres-backed, survives a restart, no in-memory
 * state):
 *
 *   no incident / PROTECTION_RESTORED  --(now unprotected)-->  MISSING_PROTECTION alert
 *                                                                -> (if this strategy's own
 *                                                                    position) queue ONE
 *                                                                    restore attempt
 *                                                                -> PROTECTION_RESTORE_REQUESTED
 *
 *   PROTECTION_RESTORE_REQUESTED  --(still unprotected on the NEXT real snapshot)-->
 *       genuine reconciliation confirms the one attempt did not actually fix it
 *       (regardless of what the collector's own modify-response said — an
 *       "ambiguous" or even a falsely-optimistic report is caught here, by
 *       checking ACTUAL position state instead of trusting that response)
 *       -> queue a close (`GoldCloseExecutionService`, dedup'd) ->
 *       PROTECTION_REMEDIATION_CLOSE_REQUESTED
 *
 *   PROTECTION_REMEDIATION_CLOSE_REQUESTED  --(still unprotected)-->  no-op
 *       (close is already in flight; the position will stop appearing in
 *       snapshots once MT5 confirms the close, ending this loop naturally)
 *
 *   MISSING_PROTECTION only (magic didn't match this strategy)  -->  no-op
 *       (alerted once, deliberately never remediated — see ownership check)
 *
 *   isProtected && last state was any of the above  -->  PROTECTION_RESTORED alert
 *
 * Ownership scoping (task item 4's principle, applied here too): the ALERT
 * fires for any unprotected XAUUSD position, but restore/close remediation
 * is strictly scoped to positions matching this strategy's own MT5 magic
 * number — never a manual trade or another bot's position.
 */
@Injectable()
export class GoldProtectionMonitorService {
  private readonly logger = new Logger(GoldProtectionMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly goldTelegram: GoldTelegramService,
    private readonly goldAiSummary: GoldAiSummaryService,
    private readonly protectionRestore: GoldProtectionRestoreService,
    private readonly closeExecution: GoldCloseExecutionService,
  ) {}

  async checkPositions(accountId: string, positions: IncomingPositionDto[]): Promise<void> {
    const goldPositions = positions.filter((p) => p.symbol.toUpperCase() === GOLD_SYMBOL);
    for (const position of goldPositions) {
      try {
        await this.checkOne(accountId, position);
      } catch (err) {
        this.logger.error(
          `protection check failed for position ${position.externalPositionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async checkOne(accountId: string, position: IncomingPositionDto): Promise<void> {
    const isProtected = isSet(position.stopLoss) && isSet(position.takeProfit);
    const positionId = position.externalPositionId;

    const lastNotification = await this.prisma.goldTelegramNotification.findFirst({
      where: { dedupKey: { startsWith: `protection:${positionId}:` } },
      orderBy: { createdAt: 'desc' },
    });
    const lastEventType = lastNotification?.eventType;

    if (isProtected) {
      if (lastEventType === 'MISSING_PROTECTION' || lastEventType === 'PROTECTION_RESTORE_REQUESTED' || lastEventType === 'PROTECTION_REMEDIATION_CLOSE_REQUESTED') {
        const dedupKey = `protection:${positionId}:restored:${Date.now()}`;
        const text = `GOLD DEMO — protection restored (reconciled against actual broker data). position=${positionId} stopLoss=${position.stopLoss} takeProfit=${position.takeProfit}`;
        await this.goldTelegram.notify('PROTECTION_RESTORED', dedupKey, text);
        this.logger.log(`gold position ${positionId}: protection restored`);
      }
      return;
    }

    // From here on: NOT protected right now.

    if (lastEventType === undefined || lastEventType === 'PROTECTION_RESTORED') {
      // New incident.
      const dedupKey = `protection:${positionId}:missing:${Date.now()}`;
      const text =
        `GOLD DEMO — CRITICAL: missing protection. position=${positionId} side=${position.side} volume=${position.volume} ` +
        `openPrice=${position.openPrice} stopLoss=${position.stopLoss ?? 'NONE'} takeProfit=${position.takeProfit ?? 'NONE'} — ` +
        `broker does not currently show a stop-loss and/or take-profit attached to this position.`;
      await this.goldTelegram.notify('MISSING_PROTECTION', dedupKey, text);
      void this.goldAiSummary.generateForEvent('MISSING_PROTECTION', new Date().toISOString(), text);
      this.logger.warn(`gold position ${positionId}: missing protection detected`);

      if (!isOwnMagic(position)) {
        this.logger.warn(`gold position ${positionId}: unprotected but magic does not match this strategy (or is absent) — alerted only, NOT auto-remediated (not confirmed to be this strategy's own position).`);
        return;
      }

      try {
        const { id: restoreRequestId } = await this.protectionRestore.requestRestore({
          accountId,
          positionTicket: positionId,
          side: position.side,
          entryPrice: position.openPrice,
          goldPointSize: GOLD_POINT_SIZE,
          // Each owner's own distance — an old position is never re-protected
          // at the new strategy's $5.
          protectionUsd: protectionUsdFor(position),
        });
        const text2 =
          `GOLD DEMO — REMEDIATION: requesting ONE protection-restore attempt for unprotected position=${positionId} (request=${restoreRequestId}). ` +
          `Queued for the collector's next poll. If still unprotected on the next snapshot (verified against actual broker data), this will be closed — no further restore retries.`;
        await this.goldTelegram.notify('PROTECTION_RESTORE_REQUESTED', `protection:${positionId}:restore-requested:${Date.now()}`, text2);
      } catch (err) {
        this.logger.error(`remediation restore-request failed for position ${positionId}: ${err instanceof Error ? err.message : String(err)}`);
        await this.goldTelegram.notify(
          'PROTECTION_REMEDIATION_FAILED',
          `protection:${positionId}:remediation-failed:${Date.now()}`,
          `GOLD DEMO — CRITICAL: could not queue a protection restore for unprotected position=${positionId}: ${err instanceof Error ? err.message : String(err)}. Manual intervention required.`,
        );
      }
      return;
    }

    if (lastEventType === 'PROTECTION_RESTORE_REQUESTED') {
      // Reconciliation: the ONE restore attempt has already been made (in an
      // earlier cycle), and the position is STILL unprotected right now,
      // according to REAL broker-reported data on this snapshot — not the
      // modify-request's own response, which is deliberately never
      // consulted here. This is the agreed trigger to close.
      if (!isOwnMagic(position)) {
        // Should not normally happen (we only ever reach RESTORE_REQUESTED for
        // our own positions), but never close something not confirmed ours.
        this.logger.warn(`gold position ${positionId}: reconciliation found still-unprotected but magic no longer matches — not closing.`);
        return;
      }
      try {
        const { request, duplicate } = await this.closeExecution.requestClose({
          accountId, positionTicket: positionId, side: position.side, volume: position.volume,
        });
        const text =
          `GOLD DEMO — REMEDIATION: reconciliation confirms position=${positionId} is still unprotected after the one restore attempt — closing (request=${request.id}${duplicate ? ', already queued' : ''}).`;
        await this.goldTelegram.notify('PROTECTION_REMEDIATION_CLOSE_REQUESTED', `protection:${positionId}:remediation-close:${Date.now()}`, text);
        this.logger.warn(`gold position ${positionId}: restore attempt did not result in protection — closing`);
      } catch (err) {
        this.logger.error(`remediation close-request failed for position ${positionId}: ${err instanceof Error ? err.message : String(err)}`);
        await this.goldTelegram.notify(
          'PROTECTION_REMEDIATION_FAILED',
          `protection:${positionId}:remediation-failed:${Date.now()}`,
          `GOLD DEMO — CRITICAL: could not queue a remediation close for unprotected position=${positionId}: ${err instanceof Error ? err.message : String(err)}. Manual intervention required.`,
        );
      }
      return;
    }

    // lastEventType is 'MISSING_PROTECTION' (not our position, alerted once,
    // never remediated) or 'PROTECTION_REMEDIATION_CLOSE_REQUESTED' (close
    // already in flight) — either way, nothing further to do this cycle.
  }
}

function isSet(value: number | undefined | null): boolean {
  return value !== undefined && value !== null && value !== 0;
}

/**
 * Reads the MT5 magic number out of the position's raw payload. Never
 * assumed present, and a missing magic never matches an owner.
 */
function magicOf(position: IncomingPositionDto): number | null {
  const raw = (position as { raw?: Record<string, unknown> }).raw;
  const magic = raw?.magic;
  return typeof magic === 'number' && Number.isFinite(magic) ? magic : null;
}

/**
 * True when this application opened the position and may therefore remediate
 * it — which now covers BOTH the active RSI strategy and the retired H4 one,
 * because the retired strategy's open positions must keep their protective
 * management until they resolve (migration spec §2).
 *
 * A foreign or manual position still raises the missing-protection ALERT
 * above; it is simply never restored or closed.
 */
function isOwnMagic(position: IncomingPositionDto): boolean {
  return isOwnedByThisApplication(magicOf(position));
}

/** The protective distance the position's OWN strategy manages it at. */
function protectionUsdFor(position: IncomingPositionDto): number {
  return ownerForMagic(magicOf(position))?.stopLossUsd ?? GOLD_TP_SL_USD;
}
