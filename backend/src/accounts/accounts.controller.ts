import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { DashboardTokenGuard, FastifyRequestWithDashboardAccount } from '../auth/dashboard-token.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from './accounts.service';

// Dashboard-authenticated and account-bound (production-readiness review —
// Option B). Never exposes ApiCredential or User rows beyond the account's
// own display fields.
@Controller('accounts')
@UseGuards(DashboardTokenGuard)
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly prisma: PrismaService,
  ) {}

  // The one route with no :id/:accountId of its own — DashboardTokenGuard
  // has nothing to compare against here, so it only enforces "a valid,
  // bound dashboard token was presented" and attaches which account that
  // is. This must return ONLY that account, never every account in the
  // system — a dashboard token is scoped to one account exactly like a
  // collector token is, so "list all accounts" would otherwise be the one
  // remaining way to read across the account boundary.
  @Get()
  async list(@Req() request: FastifyRequestWithDashboardAccount) {
    return this.prisma.tradingAccount.findMany({
      where: { id: request.dashboardAccountId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        platform: true,
        externalAccountId: true,
        broker: true,
        currency: true,
        displayName: true,
        isActive: true,
        tradingDayTimezone: true,
        tradingDayResetHour: true,
        createdAt: true,
      },
    });
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.getOrThrow(id);
  }
}
