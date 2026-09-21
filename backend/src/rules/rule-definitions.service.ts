import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RuleDefinition, RuleType } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { BREAKOUT_FRESHNESS_MS } from './evaluators/ichimoku-breakout.evaluator';
import { CompoundParams } from './dto/rule-parameters.dto';
import { validateRuleParameters } from './dto/validate-rule-parameters';
import { RuleStateService } from './rule-state.service';

export interface CreateRuleInput {
  name: string;
  ruleType: RuleType;
  parameters: Record<string, unknown>;
  enabled?: boolean;
  cooldownSeconds?: number | null;
}

export interface UpdateRuleInput {
  name?: string;
  parameters?: Record<string, unknown>;
  cooldownSeconds?: number | null;
}

// RULE_ENGINE_SPEC.md §1/§12.12 decision 1: rules are account-specific
// (accountId required, never a shared/global template) — thresholds,
// cooldown, enabled state, and compound configuration all belong to one
// account.
@Injectable()
export class RuleDefinitionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly ruleStates: RuleStateService,
  ) {}

  async create(accountId: string, input: CreateRuleInput): Promise<RuleDefinition> {
    await this.accounts.getOrThrow(accountId);
    validateRuleParameters(input.ruleType, input.parameters);
    if (input.ruleType === RuleType.COMPOUND) {
      await this.validateCompoundComponents(accountId, input.parameters as unknown as CompoundParams);
    }
    if (input.ruleType === RuleType.ICHIMOKU_BREAKOUT) {
      this.validateIchimokuCooldown(input.cooldownSeconds ?? null);
    }

    // Phase 4 review — concurrency fix: every rule gets its rule_state row
    // at creation time, atomically with the rule itself, so
    // AlertLifecycleService's row lock (RuleStateService.lockForUpdate)
    // always has a row to lock from the rule's very first evaluation
    // onward — no window where two concurrent first-triggers could both
    // find "no row" and both try to create one.
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.ruleDefinition.create({
        data: {
          accountId,
          name: input.name,
          ruleType: input.ruleType,
          parameters: input.parameters as Prisma.InputJsonValue,
          enabled: input.enabled ?? true,
          cooldownSeconds: input.cooldownSeconds ?? null,
        },
      });
      await tx.ruleState.create({ data: { ruleId: rule.id, accountId, state: 'INACTIVE' } });
      return rule;
    });
  }

  async update(ruleId: string, input: UpdateRuleInput): Promise<RuleDefinition> {
    const existing = await this.getOrThrow(ruleId);
    const nextParameters = (input.parameters ?? existing.parameters) as Record<string, unknown>;
    validateRuleParameters(existing.ruleType, nextParameters);
    if (existing.ruleType === RuleType.COMPOUND && input.parameters) {
      await this.validateCompoundComponents(
        existing.accountId,
        nextParameters as unknown as CompoundParams,
        ruleId,
      );
    }
    if (existing.ruleType === RuleType.ICHIMOKU_BREAKOUT && 'cooldownSeconds' in input) {
      this.validateIchimokuCooldown(input.cooldownSeconds ?? null);
    }

    return this.prisma.ruleDefinition.update({
      where: { id: ruleId },
      data: {
        name: input.name,
        parameters: input.parameters ? (input.parameters as Prisma.InputJsonValue) : undefined,
        cooldownSeconds: input.cooldownSeconds,
      },
    });
  }

  /**
   * Disabling forces `rule_state` to INACTIVE in the same operation
   * (RULE_ENGINE_SPEC.md §4) — otherwise a stale ACTIVE reading from before
   * the disable could keep satisfying a COMPOUND rule that references it
   * forever.
   */
  async setEnabled(ruleId: string, enabled: boolean, now: Date = new Date()): Promise<RuleDefinition> {
    const rule = await this.getOrThrow(ruleId);
    const updated = await this.prisma.ruleDefinition.update({ where: { id: ruleId }, data: { enabled } });
    if (!enabled) {
      await this.ruleStates.markInactive(ruleId, rule.accountId, now);
    }
    return updated;
  }

  async getOrThrow(ruleId: string): Promise<RuleDefinition> {
    const rule = await this.prisma.ruleDefinition.findUnique({ where: { id: ruleId } });
    if (!rule) {
      throw new NotFoundException(`No rule with id ${ruleId}`);
    }
    return rule;
  }

  /** Evaluation order (leaf types first, COMPOUND last) is applied by the caller — RuleEngineService. */
  async findEnabledForAccount(accountId: string): Promise<RuleDefinition[]> {
    return this.prisma.ruleDefinition.findMany({ where: { accountId, enabled: true } });
  }

  /** Every rule for an account, enabled or not — for management/listing (scripts/manage-rules.ts), never used by the evaluation path. */
  async findAllForAccount(accountId: string): Promise<RuleDefinition[]> {
    return this.prisma.ruleDefinition.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
  }

  // Reliability fix (production hardening pass) — ICHIMOKU_BREAKOUT's own
  // freshness window (ichimoku-breakout.evaluator.ts's BREAKOUT_FRESHNESS_MS)
  // only prevents re-notifying on a stale breakout if the rule's cooldown
  // outlasts it (see that file's comment for the full reasoning: a shorter
  // cooldown would let RuleState re-notify on an already-alerted breakout
  // once cooldown expires, before the breakout goes stale). Enforced here,
  // at creation/update time, rather than left as a convention someone could
  // violate by accident. `null` (deferring to RULE_DEFAULT_COOLDOWN_SECONDS,
  // 1800s by default — already comfortably longer) is always allowed.
  private validateIchimokuCooldown(cooldownSeconds: number | null): void {
    if (cooldownSeconds === null) return;
    const freshnessSeconds = BREAKOUT_FRESHNESS_MS / 1000;
    if (cooldownSeconds <= freshnessSeconds) {
      throw new BadRequestException(
        `ICHIMOKU_BREAKOUT's cooldownSeconds must be greater than the breakout freshness window (${freshnessSeconds}s) — ` +
          `otherwise a stale breakout could re-notify once cooldown expires, before it goes stale. Got ${cooldownSeconds}s.`,
      );
    }
  }

  // RULE_ENGINE_SPEC.md §1 — component_rule_ids must be non-COMPOUND (flat,
  // no nesting) and, per the account-specific decision above, must belong
  // to the SAME account as the compound rule itself.
  private async validateCompoundComponents(
    accountId: string,
    params: CompoundParams,
    excludeRuleId?: string,
  ): Promise<void> {
    const componentRuleIds = params.component_rule_ids;

    if (excludeRuleId && componentRuleIds.includes(excludeRuleId)) {
      throw new BadRequestException('A COMPOUND rule cannot reference itself');
    }
    if (new Set(componentRuleIds).size !== componentRuleIds.length) {
      throw new BadRequestException('component_rule_ids must not contain duplicates');
    }

    const components = await this.prisma.ruleDefinition.findMany({
      where: { id: { in: componentRuleIds } },
      select: { id: true, accountId: true, ruleType: true },
    });

    if (components.length !== componentRuleIds.length) {
      throw new BadRequestException('One or more component_rule_ids do not exist');
    }
    for (const component of components) {
      if (component.accountId !== accountId) {
        throw new BadRequestException(
          `component_rule_ids must belong to the same account as the compound rule (${component.id} does not)`,
        );
      }
      if (component.ruleType === RuleType.COMPOUND) {
        throw new BadRequestException(
          `component_rule_ids must not reference another COMPOUND rule (${component.id}) — compound rules are flat, one level`,
        );
      }
    }
  }
}
