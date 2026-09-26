import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PrismaService } from '../prisma/prisma.service';
import { authenticateBearer } from './bearer-auth';
import { collectorTokenCache } from './token-auth-cache';

/** Every /collector/* route carries the target account either in the body (POST) or the URL (GET). */
function requestedAccountId(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, string> | undefined;
  const body = request.body as Record<string, unknown> | undefined;
  return params?.accountId ?? (typeof body?.accountId === 'string' ? body.accountId : undefined);
}

// Verifies the collector's bearer token against a stored argon2id hash, AND
// (production-readiness review, item 1) that the token is bound to the
// SAME account the request targets — closing the gap where any valid
// collector token could submit data for any known account. The shared
// path, including caching and throttling, lives in bearer-auth.ts.
@Injectable()
export class CollectorTokenGuard implements CanActivate {
  private readonly logger = new Logger(CollectorTokenGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    await authenticateBearer(request, http.getResponse?.<FastifyReply>(), {
      scope: 'collector',
      cache: collectorTokenCache,
      prisma: this.prisma,
      logger: this.logger,
      targetAccountId: requestedAccountId(request),
      // A token minted before account binding, never rotated. Reject rather
      // than treat as unrestricted — see create-collector-token.ts.
      unboundError: () =>
        new UnauthorizedException(
          'This collector token predates account binding and must be rotated: ' +
            'run `npm run create-token -- <accountId>` and update the collector\'s .env',
        ),
    });
    return true;
  }
}
