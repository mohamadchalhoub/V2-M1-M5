import { PrismaService } from '../prisma/prisma.service';
import { ComponentCheckResult } from './health-checks';

/**
 * Phase 11 (Phase 0 §26): "unique constraints and foreign keys prevent NEW
 * bad data; they don't catch drift introduced by a manual fix, a migration
 * mistake, or a bug that predates a constraint being added." This is a
 * direct, scheduled audit rather than trusting schema constraints as the
 * only line of defense — it runs the same three checks Phase 0 names
 * verbatim, even though the first (orphaned trades) should be structurally
 * impossible given the FK on `trades.account_id`: the point is to catch the
 * case where something bypassed that guarantee (a raw migration, a manual
 * `DELETE ... CASCADE`-disabled fix), not to assume it never will.
 */
export async function checkDataIntegrity(prisma: PrismaService): Promise<ComponentCheckResult> {
  const [orphanedTrades, negativeTradeVolumes, negativePositionVolumes, emptyRuleSnapshots] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM trades t
      LEFT JOIN trading_accounts a ON a.id = t.account_id
      WHERE a.id IS NULL
    `,
    prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM trades WHERE volume < 0`,
    prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM positions WHERE volume < 0`,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM alerts
      WHERE rule_snapshot IS NULL OR rule_snapshot = '{}'::jsonb
    `,
  ]);

  const findings = {
    orphanedTrades: Number(orphanedTrades[0].count),
    negativeTradeVolumes: Number(negativeTradeVolumes[0].count),
    negativePositionVolumes: Number(negativePositionVolumes[0].count),
    emptyRuleSnapshots: Number(emptyRuleSnapshots[0].count),
  };

  const totalIssues = Object.values(findings).reduce((sum, n) => sum + n, 0);

  if (totalIssues === 0) {
    return { status: 'OK', detail: findings };
  }
  return { status: 'DOWN', detail: findings };
}
