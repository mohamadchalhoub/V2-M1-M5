import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, RuleDefinition, RuleRunState } from '@prisma/client';
import { Queue } from 'bullmq';
import { AI_ANALYSIS_QUEUE, TELEGRAM_DELIVERY_QUEUE, aiAnalysisJobId, deliveryJobId } from '../jobs/jobs.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RuleStateService } from '../rules/rule-state.service';
import { RuleEvaluationResult, RuleEvaluationStatus } from '../rules/types/rule-engine.types';

const DEFAULT_COOLDOWN_SECONDS = 1800;

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

interface ApplyOutcome {
  deliveryId: string;
  /** Only set for a FRESH episode (INACTIVE/no-row → ACTIVE) — a cooldown re-notify never gets an AiAnalysis row (AI_INTEGRATION_SPEC.md §8 decision: narrate the first alert of an episode only). */
  aiAnalysisId: string | null;
}

/**
 * Applies RULE_ENGINE_SPEC.md §4's transition table — the ONLY place that
 * decides whether a `rule_state` transition happens and whether a new
 * `Alert` row gets created. `AnalyticsService`/the pure evaluators never call
 * this; only `RuleEngineService` does, once per evaluated rule.
 *
 * Phase 5 addition: every `Alert` this creates also gets an `AlertDelivery`
 * row, in the SAME transaction (PHASE5_DELIVERY_SPEC.md §1/§3 — the
 * transactional-outbox pattern: an Alert never exists without its delivery
 * record).
 *
 * Phase 6 addition: a FRESH-episode Alert (not a cooldown re-notify) also
 * gets an `AiAnalysis` row, same transaction, same outbox reasoning
 * (AI_INTEGRATION_SPEC.md §5). This service stays completely ignorant of
 * whether AI is even enabled — it always creates the row and always
 * enqueues generation; `ai`'s own worker is the one that checks
 * `AI_ENABLED` and marks itself SKIPPED when it's off. That keeps `alerts`
 * from needing to import anything AI-configuration-shaped.
 *
 * Both BullMQ enqueues happen AFTER the transaction commits, each in its own
 * try/catch — a Redis hiccup can never roll back an already-decided Alert,
 * and never blocks/fails this call (Telegram's reconciliation sweep covers
 * a lost delivery-enqueue; a lost AI-analysis-enqueue simply means that
 * episode never gets a narrative, which is an acceptable degradation for an
 * optional enrichment, §7 of the spec).
 */
@Injectable()
export class AlertLifecycleService {
  private readonly logger = new Logger(AlertLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ruleStates: RuleStateService,
    @Inject(TELEGRAM_DELIVERY_QUEUE) private readonly deliveryQueue: Queue,
    @Inject(AI_ANALYSIS_QUEUE) private readonly aiAnalysisQueue: Queue,
  ) {}

  private defaultCooldownSeconds(): number {
    const raw = this.config.get<string>('RULE_DEFAULT_COOLDOWN_SECONDS');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COOLDOWN_SECONDS;
  }

  async apply(rule: RuleDefinition, result: RuleEvaluationResult): Promise<void> {
    // §4/§8 — a true no-op: never resolves an active alert, never creates one.
    if (result.status === RuleEvaluationStatus.INSUFFICIENT_DATA) {
      return;
    }

    let outcome: ApplyOutcome | null;
    try {
      outcome = await this.applyLocked(rule, result);
    } catch (err) {
      // Only possible when `rule_state` had no row yet for this rule (a
      // rule created before this fix, or a rare first-ever-trigger race —
      // see lockForUpdate's doc comment: FOR UPDATE has nothing to lock
      // until a row exists) AND two concurrent transactions both tried to
      // INSERT it: one wins, the other hits this unique-violation. Retrying
      // once now finds the row the winner just created and takes the
      // normal locked path — never a second Alert for the same trigger.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        outcome = await this.applyLocked(rule, result);
      } else {
        throw err;
      }
    }

    if (outcome) {
      await this.enqueueDeliverySafely(outcome.deliveryId);
      if (outcome.aiAnalysisId) {
        await this.enqueueAiAnalysisSafely(outcome.aiAnalysisId);
      }
    }
  }

  // Best-effort — a Redis outage here must never fail `apply()` or roll back
  // the Alert/AlertDelivery rows already committed to Postgres
  // (PHASE5_DELIVERY_SPEC.md §7). The deterministic jobId means this can
  // never create a duplicate job even if the reconciliation sweep also
  // tries to enqueue the same delivery moments later.
  private async enqueueDeliverySafely(alertDeliveryId: string): Promise<void> {
    try {
      await this.deliveryQueue.add(
        'deliver',
        { alertDeliveryId },
        { jobId: deliveryJobId(alertDeliveryId) },
      );
    } catch (err) {
      this.logger.warn(
        `failed to enqueue delivery ${alertDeliveryId}, reconciliation sweep will retry: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // Same best-effort posture as enqueueDeliverySafely — AI narration is an
  // optional enrichment (AI_INTEGRATION_SPEC.md §0), so a failure here is
  // logged and dropped, never surfaced as an alert-processing failure.
  private async enqueueAiAnalysisSafely(aiAnalysisId: string): Promise<void> {
    try {
      await this.aiAnalysisQueue.add(
        'generate',
        { aiAnalysisId },
        { jobId: aiAnalysisJobId(aiAnalysisId) },
      );
    } catch (err) {
      this.logger.warn(
        `failed to enqueue AI analysis ${aiAnalysisId}: ` + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // Phase 4 review — concurrency fix: the whole read-decide-write sequence
  // now runs inside one transaction, holding a row lock on `rule_state` for
  // its duration (RuleStateService.lockForUpdate). Two ingestion requests
  // for the same account landing close together (a retried push overlapping
  // the original, or — as found during the real-MT5 verification — two
  // collector processes pointed at the same account) used to be able to
  // both read INACTIVE and both create an Alert; the second transaction now
  // blocks until the first commits, then correctly sees ACTIVE-within-
  // cooldown and no-ops.
  /** Returns the outcome of this call when an alert was created, else null. */
  private async applyLocked(rule: RuleDefinition, result: RuleEvaluationResult): Promise<ApplyOutcome | null> {
    const now = result.evaluatedAt;
    const cooldownSeconds = rule.cooldownSeconds ?? this.defaultCooldownSeconds();

    return this.prisma.$transaction(async (tx) => {
      const state = await this.ruleStates.lockForUpdate(tx, rule.id);

      if (result.status === RuleEvaluationStatus.NOT_TRIGGERED) {
        if (state?.state === RuleRunState.ACTIVE) {
          await this.ruleStates.markInactive(rule.id, rule.accountId, now, tx);
        }
        // INACTIVE (or no row yet) + NOT_TRIGGERED: no-op.
        return null;
      }

      // result.status === TRIGGERED
      if (!state || state.state === RuleRunState.INACTIVE) {
        // Fresh episode — this is the ONLY branch that gets an AiAnalysis
        // row (AI_INTEGRATION_SPEC.md §8: narrate the first alert of an
        // episode, not every cooldown re-notify).
        const { delivery, aiAnalysis } = await this.createAlert(tx, rule, result, now, { withAiAnalysis: true });
        await this.ruleStates.markActive(rule.id, rule.accountId, now, addSeconds(now, cooldownSeconds), tx);
        return { deliveryId: delivery.id, aiAnalysisId: aiAnalysis!.id };
      }

      // state.state === ACTIVE
      if (state.cooldownUntil && state.cooldownUntil > now) {
        // Still within cooldown — deduplicated, no new alert (§5).
        return null;
      }

      // Cooldown elapsed (or somehow null) and still TRIGGERED — re-notify.
      // No AiAnalysis for this one (same episode, already narrated once).
      const { delivery } = await this.createAlert(tx, rule, result, now, { withAiAnalysis: false });
      await this.ruleStates.refreshCooldown(rule.id, addSeconds(now, cooldownSeconds), tx);
      return { deliveryId: delivery.id, aiAnalysisId: null };
    });
  }

  // §6 — trigger_values / baseline_snapshot / rule_snapshot are JSON copies
  // taken here, at creation time, and never touched again: a later edit to
  // the live rule or a later shift in the rolling baseline can never rewrite
  // what this row says happened.
  //
  // Phase 5: also creates the AlertDelivery row in the SAME transaction —
  // an Alert never exists without its delivery record (PHASE5_DELIVERY_SPEC.md
  // §1/§3). `alertId` is `@unique` on both AlertDelivery and AiAnalysis, so
  // neither can ever get a second row for the same alert even if somehow
  // called twice.
  private async createAlert(
    tx: Prisma.TransactionClient,
    rule: RuleDefinition,
    result: RuleEvaluationResult,
    now: Date,
    options: { withAiAnalysis: boolean },
  ): Promise<{ delivery: { id: string }; aiAnalysis: { id: string } | null }> {
    const alert = await tx.alert.create({
      data: {
        ruleId: rule.id,
        accountId: rule.accountId,
        triggeredAt: now,
        triggerValues: result.triggerValues as Prisma.InputJsonValue,
        baselineSnapshot: result.baselineValues as Prisma.InputJsonValue,
        ruleSnapshot: {
          id: rule.id,
          name: rule.name,
          ruleType: rule.ruleType,
          parameters: rule.parameters,
          cooldownSeconds: rule.cooldownSeconds,
          enabled: rule.enabled,
        } as Prisma.InputJsonValue,
      },
    });

    const delivery = await tx.alertDelivery.create({
      data: { alertId: alert.id, class: 'TRADING_ALERT' },
      select: { id: true },
    });

    const aiAnalysis = options.withAiAnalysis
      ? await tx.aiAnalysis.create({ data: { alertId: alert.id }, select: { id: true } })
      : null;

    return { delivery, aiAnalysis };
  }
}
