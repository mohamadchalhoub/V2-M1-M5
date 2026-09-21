import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../prisma/prisma.service';
import { verifyToken } from './token.util';

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
 * mismatch check below treats as "nothing to compare against" — same as
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
// presented here fails the scope filter below exactly the same way an
// invalid token would, and vice versa in CollectorTokenGuard. The plaintext
// token is NEVER logged here or anywhere downstream — only its 8-character
// prefix (already non-secret) ever appears in a log line.
@Injectable()
export class DashboardTokenGuard implements CanActivate {
  private readonly logger = new Logger(DashboardTokenGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequestWithDashboardAccount>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const plaintext = header.slice('Bearer '.length).trim();
    if (plaintext.length < 16) {
      throw new UnauthorizedException('Malformed token');
    }
    const prefix = plaintext.slice(0, 8);

    const candidates = await this.prisma.apiCredential.findMany({
      where: { tokenPrefix: prefix, revokedAt: null, scope: 'dashboard' },
    });

    for (const candidate of candidates) {
      if (await verifyToken(candidate.tokenHash, plaintext)) {
        if (!candidate.accountId) {
          // Should be unreachable in practice — create-dashboard-token.ts
          // always binds one — but never treat an unbound dashboard
          // credential as unrestricted, same posture as the collector guard.
          this.logger.warn(`Rejected dashboard token prefix ${prefix}: not bound to an account`);
          throw new UnauthorizedException(
            'This dashboard token is not bound to an account and must be rotated: ' +
              'run `npm run create-dashboard-token -- <accountId>`',
          );
        }

        const target = requestedAccountId(request);
        if (target && target !== candidate.accountId) {
          this.logger.warn(`Rejected dashboard token prefix ${prefix}: bound to a different account`);
          throw new ForbiddenException('This token is not authorized for the requested account');
        }

        await this.prisma.apiCredential.update({
          where: { id: candidate.id },
          data: { lastUsedAt: new Date() },
        });
        request.dashboardAccountId = candidate.accountId;
        return true;
      }
    }

    // A collector token, an invalid token, and a revoked dashboard token
    // all land here identically — scope='dashboard' in the query above
    // already excludes every collector-scoped row, so a valid COLLECTOR
    // token can never verify successfully against this guard no matter
    // what it's compared against.
    this.logger.warn(`Rejected dashboard token with prefix ${prefix}`);
    throw new UnauthorizedException('Invalid or revoked token');
  }
}
