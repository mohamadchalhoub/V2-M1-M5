/**
 * Rotates the collector API token FOR ONE ACCOUNT: revokes any existing
 * active collector credential bound to that account and mints a new one
 * bound to it (production-readiness review, item 1 — every collector
 * token is now tied to exactly one account; there is no more "shared,
 * unbound" token).
 *
 * Run: npm run create-token -- <accountId>
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { generateCollectorToken, hashToken } from '../src/auth/token.util';

const prisma = new PrismaClient();

async function main() {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('Usage: npm run create-token -- <accountId>');
    console.error('Find account ids with: npx prisma studio, or GET /accounts once the API is running.');
    process.exitCode = 1;
    return;
  }

  const account = await prisma.tradingAccount.findUnique({ where: { id: accountId } });
  if (!account) {
    console.error(`No trading account with id ${accountId}`);
    process.exitCode = 1;
    return;
  }

  const revoked = await prisma.apiCredential.updateMany({
    where: { accountId, scope: 'collector', revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count > 0) {
    console.log(`Revoked ${revoked.count} existing token(s) for this account.`);
  }

  const { plaintext, prefix } = generateCollectorToken();
  const tokenHash = await hashToken(plaintext);
  await prisma.apiCredential.create({
    data: {
      name: `mt5-collector-${account.id}`,
      tokenHash,
      tokenPrefix: prefix,
      scope: 'collector',
      accountId: account.id,
    },
  });

  console.log(`\nNew collector token for ${account.displayName ?? account.externalAccountId} — shown ONCE, copy it now:\n\n  ${plaintext}\n`);
  console.log(`Update COLLECTOR_API_KEY in the collector's .env, then restart it.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
