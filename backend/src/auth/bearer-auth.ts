/**
 * The authentication path shared by CollectorTokenGuard and
 * DashboardTokenGuard, cheapest checks first:
 *
 *   1. failure rate limit for this client      (429, no work done)
 *   2. Authorization header and token shape    (401, no lookup, no Argon2)
 *   3. successful-verification cache hit       (credential row re-read, no Argon2)
 *   4. cache miss: prefix lookup + Argon2, deduplicated per token and gated
 *   5. account binding
 *   6. throttled, best-effort lastUsedAt write
 *
 * The plaintext token is never logged, stored or returned. Only the
 * 8-character prefix of a well-formed token (non-secret, stored beside the
 * hash for exactly this purpose) appears in log lines.
 */
import { ForbiddenException, HttpException, HttpStatus, Logger, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaService } from '../prisma/prisma.service';
import { verifyToken } from './token.util';
import { isWellFormedToken, type TokenScope } from './token-format';
import { tokenDigest, type TokenAuthCache, type VerifiedCredential } from './token-auth-cache';
import { argon2Gate, authFailureLimiter, clientKey } from './auth-throttle';

/** Valid hash, but the credential predates account binding: rejected, never cached. */
export const UNBOUND = Symbol('unbound');
const GATE_FULL = Symbol('gate-full');

export interface BearerAuthOptions {
  readonly scope: TokenScope;
  readonly cache: TokenAuthCache;
  readonly prisma: PrismaService;
  readonly logger: Logger;
  /** The account the request targets, if it names one. */
  readonly targetAccountId: string | undefined;
  /** Thrown (after counting the failure) for a correct token bound to no account. */
  readonly unboundError: () => Error;
}

export async function authenticateBearer(
  request: FastifyRequest,
  reply: FastifyReply | undefined,
  opts: BearerAuthOptions,
): Promise<VerifiedCredential> {
  const { scope, cache, prisma, logger } = opts;
  const nowMs = Date.now();
  const client = clientKey(request);

  const retryAfter = authFailureLimiter.retryAfterSeconds(client, nowMs);
  if (retryAfter > 0) throw tooManyRequests(reply, retryAfter, 'Too many failed authentication attempts');

  const fail = (error: Error): Error => {
    authFailureLimiter.recordFailure(client, nowMs);
    return error;
  };

  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw fail(new UnauthorizedException('Missing bearer token'));
  const plaintext = header.slice('Bearer '.length).trim();
  if (!isWellFormedToken(scope, plaintext)) {
    logger.warn(`Rejected malformed ${scope} token`);
    throw fail(new UnauthorizedException('Malformed token'));
  }
  const prefix = plaintext.slice(0, 8);
  const digest = tokenDigest(plaintext);

  let verified: VerifiedCredential | null = null;
  const cached = cache.get(digest, nowMs);
  if (cached) {
    // The cache only skips Argon2. The credential row is still re-read on
    // every request, so revocation, rotation or deletion by another
    // process takes effect immediately.
    const row = await prisma.apiCredential.findFirst({
      where: { id: cached.credentialId, revokedAt: null, scope },
      select: { id: true, accountId: true },
    });
    if (row && row.accountId === cached.accountId) verified = cached;
    else cache.delete(digest);
  }

  if (!verified) {
    const outcome = await cache.verifyOnce(digest, async () => {
      const verify = () => verifyWithArgon2(prisma, scope, prefix, plaintext);
      if (cache.isKnownGood(digest, nowMs)) return verify();
      const gated = await argon2Gate.run(verify);
      return gated.ok ? gated.value : GATE_FULL;
    });
    if (outcome === GATE_FULL) {
      logger.warn(`Refused ${scope} token prefix ${prefix}: authentication queue full`);
      throw tooManyRequests(reply, 5, 'Authentication is busy, retry shortly');
    }
    if (outcome === UNBOUND) {
      logger.warn(`Rejected ${scope} token prefix ${prefix}: not bound to an account`);
      throw fail(opts.unboundError());
    }
    if (!outcome) {
      logger.warn(`Rejected ${scope} token with prefix ${prefix}`);
      throw fail(new UnauthorizedException('Invalid or revoked token'));
    }
    verified = outcome;
    cache.set(digest, verified, nowMs);
  }

  if (opts.targetAccountId && opts.targetAccountId !== verified.accountId) {
    logger.warn(`Rejected ${scope} token prefix ${prefix}: bound to a different account`);
    throw fail(new ForbiddenException('This token is not authorized for the requested account'));
  }

  if (cache.claimLastUsedWrite(verified.credentialId, nowMs)) {
    // Bookkeeping only: authentication has already succeeded and must not
    // depend on this write.
    prisma.apiCredential
      .update({ where: { id: verified.credentialId }, data: { lastUsedAt: new Date(nowMs) } })
      .catch((err: unknown) => {
        logger.warn(`lastUsedAt update failed for ${scope} credential ${verified!.credentialId}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
  return verified;
}

/** The authoritative path: prefix lookup, then Argon2 against each candidate. */
async function verifyWithArgon2(
  prisma: PrismaService,
  scope: TokenScope,
  prefix: string,
  plaintext: string,
): Promise<VerifiedCredential | typeof UNBOUND | null> {
  const candidates = await prisma.apiCredential.findMany({
    where: { tokenPrefix: prefix, revokedAt: null, scope },
  });
  for (const candidate of candidates) {
    if (await verifyToken(candidate.tokenHash, plaintext)) {
      if (!candidate.accountId) return UNBOUND;
      return { credentialId: candidate.id, accountId: candidate.accountId };
    }
  }
  return null;
}

function tooManyRequests(reply: FastifyReply | undefined, retryAfterSeconds: number, message: string): HttpException {
  reply?.header?.('Retry-After', String(retryAfterSeconds));
  return new HttpException(
    { statusCode: HttpStatus.TOO_MANY_REQUESTS, message, error: 'Too Many Requests' },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
