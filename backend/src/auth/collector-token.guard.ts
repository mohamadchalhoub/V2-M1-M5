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

/** Every /collector/* route carries the target account either in the body (POST) or the URL (GET). */
function requestedAccountId(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, string> | undefined;
  const body = request.body as Record<string, unknown> | undefined;
  return params?.accountId ?? (typeof body?.accountId === 'string' ? body.accountId : undefined);
}

// Verifies the collector's bearer token against a stored argon2id hash, AND
// (production-readiness review, item 1) that the token is bound to the
// SAME account the request targets — closing the gap where any valid
// collector token could submit data for any known account. The plaintext
// token is NEVER logged here or anywhere downstream — only its 8-character
// prefix (already non-secret, stored alongside the hash specifically so
// it's safe to reference in logs/UI) ever appears in a log line.
@Injectable()
export class CollectorTokenGuard implements CanActivate {
  private readonly logger = new Logger(CollectorTokenGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
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
      where: { tokenPrefix: prefix, revokedAt: null, scope: 'collector' },
    });

    for (const candidate of candidates) {
      if (await verifyToken(candidate.tokenHash, plaintext)) {
        if (!candidate.accountId) {
          // A token minted before this fix, never rotated. Reject rather
          // than treat as unrestricted — see create-collector-token.ts.
          this.logger.warn(`Rejected collector token prefix ${prefix}: not bound to an account`);
          throw new UnauthorizedException(
            'This collector token predates account binding and must be rotated: ' +
              'run `npm run create-token -- <accountId>` and update the collector\'s .env',
          );
        }

        const target = requestedAccountId(request);
        if (target && target !== candidate.accountId) {
          this.logger.warn(`Rejected collector token prefix ${prefix}: bound to a different account`);
          throw new ForbiddenException('This token is not authorized for the requested account');
        }

        await this.prisma.apiCredential.update({
          where: { id: candidate.id },
          data: { lastUsedAt: new Date() },
        });
        return true;
      }
    }

    this.logger.warn(`Rejected collector token with prefix ${prefix}`);
    throw new UnauthorizedException('Invalid or revoked token');
  }
}
