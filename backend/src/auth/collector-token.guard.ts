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
import { collectorTokenCache, tokenDigest, type VerifiedCredential } from './collector-token-cache';

/** Valid hash, but the credential predates account binding: rejected, never cached. */
const UNBOUND = Symbol('unbound');

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
    const digest = tokenDigest(plaintext);
    const nowMs = Date.now();

    let verified: VerifiedCredential | null = null;
    const cached = collectorTokenCache.get(digest, nowMs);
    if (cached) {
      // The cache only skips Argon2. The credential row is still re-read on
      // every request, so revocation, rotation or deletion by another
      // process takes effect immediately.
      const row = await this.prisma.apiCredential.findFirst({
        where: { id: cached.credentialId, revokedAt: null, scope: 'collector' },
        select: { id: true, accountId: true },
      });
      if (row && row.accountId === cached.accountId) verified = cached;
      else collectorTokenCache.delete(digest);
    }

    if (!verified) {
      const outcome = await collectorTokenCache.verifyOnce(digest, () => this.verifyWithArgon2(prefix, plaintext));
      if (outcome === UNBOUND) {
        // A token minted before this fix, never rotated. Reject rather
        // than treat as unrestricted — see create-collector-token.ts.
        this.logger.warn(`Rejected collector token prefix ${prefix}: not bound to an account`);
        throw new UnauthorizedException(
          'This collector token predates account binding and must be rotated: ' +
            'run `npm run create-token -- <accountId>` and update the collector\'s .env',
        );
      }
      if (!outcome) {
        this.logger.warn(`Rejected collector token with prefix ${prefix}`);
        throw new UnauthorizedException('Invalid or revoked token');
      }
      verified = outcome;
      collectorTokenCache.set(digest, verified, nowMs);
    }

    const target = requestedAccountId(request);
    if (target && target !== verified.accountId) {
      this.logger.warn(`Rejected collector token prefix ${prefix}: bound to a different account`);
      throw new ForbiddenException('This token is not authorized for the requested account');
    }

    if (collectorTokenCache.claimLastUsedWrite(verified.credentialId, nowMs)) {
      await this.prisma.apiCredential.update({
        where: { id: verified.credentialId },
        data: { lastUsedAt: new Date(nowMs) },
      });
    }
    return true;
  }

  /** The authoritative path: prefix lookup, then Argon2 against each candidate. */
  private async verifyWithArgon2(prefix: string, plaintext: string): Promise<VerifiedCredential | typeof UNBOUND | null> {
    const candidates = await this.prisma.apiCredential.findMany({
      where: { tokenPrefix: prefix, revokedAt: null, scope: 'collector' },
    });
    for (const candidate of candidates) {
      if (await verifyToken(candidate.tokenHash, plaintext)) {
        if (!candidate.accountId) return UNBOUND;
        return { credentialId: candidate.id, accountId: candidate.accountId };
      }
    }
    return null;
  }
}
