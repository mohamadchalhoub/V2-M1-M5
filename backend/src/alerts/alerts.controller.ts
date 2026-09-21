import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

// Read-only, for the dashboard (Phase 9). Alerts are the append-only trigger
// log (RULE_ENGINE_SPEC.md §6) — nothing here ever mutates one, so a single
// list endpoint with the rule/delivery/AI context joined in is all a
// read-only history view needs. Dashboard-authenticated and account-bound
// (production-readiness review — Option B): DashboardTokenGuard rejects a
// token bound to a different account before this handler ever runs.
@Controller('accounts/:accountId/alerts')
@UseGuards(DashboardTokenGuard)
export class AlertsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    await this.accounts.getOrThrow(accountId);
    const { take, skip } = parsePagination(limit, offset);
    const [alerts, total] = await Promise.all([
      this.prisma.alert.findMany({
        where: { accountId },
        orderBy: { triggeredAt: 'desc' },
        take,
        skip,
        include: {
          rule: { select: { id: true, name: true, ruleType: true } },
          delivery: { select: { status: true, sentAt: true, attempts: true } },
          aiAnalysis: { select: { status: true, result: true, safetyFlagged: true } },
        },
      }),
      this.prisma.alert.count({ where: { accountId } }),
    ]);
    return { alerts, total, limit: take, offset: skip };
  }
}
