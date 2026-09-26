import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PrismaService } from '../prisma/prisma.service';
import { authenticateBearer } from './bearer-auth';
import { dashboardTokenCache } from './token-auth-cache';

export interface FastifyRequestWithDashboardAccount extends FastifyRequest {
  /** Set on success — the ONE account this credential is bound to. The one
   * route with no accountId in its own URL (`GET /accounts`) reads this to
   * know which account to scope its results to; every other route only
   * needs the pass/fail outcome below. */
  dashboardAccountId?: string;
}

/** Every dashboard route carries its target account in the URL, EXCEPT
 * POST /xtb-import, which carries it in the JSON body — mirrors
 * CollectorTokenGuard's own requestedAccountId() exactly, extended with
 * `:id` since AccountsController's single-account route uses that param
 * name instead of `:accountId`. A route with neither (GET /accounts,
 * GET /health, GET /health/incidents) returns undefined, which the
 * mismatch check treats as "nothing to compare against" — same as
 * the collector guard's own handling of an accountId-less request. */
function requestedAccountId(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, string> | undefined;
  const body = request.body as Record<string, unknown> | undefined;
  return (
    params?.accountId ??
    params?.id ??
    (typeof body?.accountId === 'string' ? body.accountId : undefined)
  );
}

// Dashboard-authenticated (production-readiness review — Option B): the
// SAME architecture as CollectorTokenGuard — an account-bound ApiCredential,
// argon2id-hashed, verified by prefix-then-hash — but a genuinely SEPARATE
// guard and a separate `scope` value ('dashboard' vs 'collector'). The two
// are never merged and never accept each other's tokens: a collector token
// presented here fails the dashboard shape check, and vice versa in
// CollectorTokenGuard. The shared path, including caching and throttling,
// lives in bearer-auth.ts.
@Injectable()
export class DashboardTokenGuard implements CanActivate {
  private readonly logger = new Logger(DashboardTokenGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequestWithDashboardAccount>();
    const verified = await authenticateBearer(request, http.getResponse?.<FastifyReply>(), {
      scope: 'dashboard',
      cache: dashboardTokenCache,
      prisma: this.prisma,
      logger: this.logger,
      targetAccountId: requestedAccountId(request),
      unboundError: () =>
        new UnauthorizedException(
          'This dashboard token is not bound to an account and must be rotated: ' +
            'run `npm run create-dashboard-token -- <accountId>`',
        ),
    });
    request.dashboardAccountId = verified.accountId;
    return true;
  }
}
