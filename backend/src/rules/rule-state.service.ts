import { Injectable } from '@nestjs/common';
import { Prisma, RuleState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ComponentStateMap } from './types/rule-engine.types';

/** Accepts either the ambient PrismaService or a `$transaction` client, so callers that need atomicity (AlertLifecycleService) can pass one in. */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * Thin read/write layer over `rule_state` (RULE_ENGINE_SPEC.md §4). Owned by
 * `rules` (Phase 0 §15's module table) because COMPOUND evaluation — reading
 * components' current state — is squarely a `rules`-module concern; the
 * *policy* for when a transition happens lives in `alerts`'
 * `AlertLifecycleService`, which calls the write methods here.
 */
@Injectable()
export class RuleStateService {
  constructor(private readonly prisma: PrismaService) {}

  async get(ruleId: string): Promise<RuleState | null> {
    return this.prisma.ruleState.findUnique({ where: { ruleId } });
  }

  /** Batch read for COMPOUND evaluation — one query for every component across every compound rule in a pass. */
  async getManyByIds(ruleIds: string[]): Promise<ComponentStateMap> {
    if (ruleIds.length === 0) return new Map();
    const rows = await this.prisma.ruleState.findMany({ where: { ruleId: { in: ruleIds } } });
    return new Map(rows.map((r) => [r.ruleId, r.state]));
  }

  /**
   * Row-level lock for AlertLifecycleService's read-decide-write sequence
   * (Phase 4 review — concurrency fix). MUST be called from inside a
   * `prisma.$transaction(...)` callback: `FOR UPDATE` only holds the lock
   * until that transaction commits/rolls back. A second concurrent
   * evaluation of the SAME rule blocks here until the first transaction
   * finishes, then sees its result — closing the race where two
   * near-simultaneous ingestion requests could otherwise both read
   * INACTIVE and both create an alert. Column list is spelled out (not
   * `SELECT *`) and aliased to the Prisma model's camelCase field names.
   */
  async lockForUpdate(tx: Prisma.TransactionClient, ruleId: string): Promise<RuleState | null> {
    const rows = await tx.$queryRaw<RuleState[]>`
      SELECT rule_id AS "ruleId", account_id AS "accountId", state,
             cooldown_until AS "cooldownUntil", last_triggered_at AS "lastTriggeredAt",
             resolved_at AS "resolvedAt", updated_at AS "updatedAt"
      FROM rule_states WHERE rule_id = ${ruleId} FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async markActive(
    ruleId: string,
    accountId: string,
    now: Date,
    cooldownUntil: Date,
    db: Db = this.prisma,
  ): Promise<RuleState> {
    return db.ruleState.upsert({
      where: { ruleId },
      create: { ruleId, accountId, state: 'ACTIVE', cooldownUntil, lastTriggeredAt: now, resolvedAt: null },
      update: { state: 'ACTIVE', cooldownUntil, lastTriggeredAt: now, resolvedAt: null },
    });
  }

  /** Cooldown-elapsed re-notify (RULE_ENGINE_SPEC.md §5) — state stays ACTIVE, lastTriggeredAt is unchanged. */
  async refreshCooldown(ruleId: string, cooldownUntil: Date, db: Db = this.prisma): Promise<RuleState> {
    return db.ruleState.update({ where: { ruleId }, data: { cooldownUntil } });
  }

  /** Also used when a rule is disabled (RULE_ENGINE_SPEC.md §4) so a stale ACTIVE reading can never leak into a COMPOUND rule. */
  async markInactive(ruleId: string, accountId: string, now: Date, db: Db = this.prisma): Promise<RuleState> {
    return db.ruleState.upsert({
      where: { ruleId },
      create: { ruleId, accountId, state: 'INACTIVE', cooldownUntil: null, resolvedAt: now },
      update: { state: 'INACTIVE', cooldownUntil: null, resolvedAt: now },
    });
  }
}
