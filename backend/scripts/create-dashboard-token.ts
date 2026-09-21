/**
 * Mints a dashboard API token FOR ONE ACCOUNT: revokes any existing active
 * dashboard credential bound to that account and mints a new one bound to
 * it — the same rotation pattern as create-collector-token.ts, a separate
 * scope ('dashboard' vs 'collector'), never interchangeable with it.
 *
 * Run: npm run create-dashboard-token -- <accountId>
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { generateDashboardToken, hashToken } from '../src/auth/token.util';

const prisma = new PrismaClient();

async function main() {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('Usage: npm run create-dashboard-token -- <accountId>');
    console.error('Find account ids with: npx prisma studio, or GET /accounts once you have a token.');
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
    where: { accountId, scope: 'dashboard', revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count > 0) {
    console.log(`Revoked ${revoked.count} existing dashboard token(s) for this account.`);
  }

  const { plaintext, prefix } = generateDashboardToken();
  const tokenHash = await hashToken(plaintext);
  await prisma.apiCredential.create({
    data: {
      name: `dashboard-${account.id}`,
      tokenHash,
      tokenPrefix: prefix,
      scope: 'dashboard',
      accountId: account.id,
    },
  });

  console.log(`\nNew dashboard token for ${account.displayName ?? account.externalAccountId} — shown ONCE, copy it now:\n\n  ${plaintext}\n`);
  console.log(`Set DASHBOARD_API_TOKEN in the frontend's server-side .env (never NEXT_PUBLIC_*), then restart it.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
