/**
 * One-time setup: creates the trader's user row, the MT5 trading_account
 * row, and (if one doesn't already exist) a collector API token.
 *
 * Run once per environment: npm run bootstrap
 * Reads BOOTSTRAP_* from .env — see .env.example.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { generateCollectorToken, hashToken } from '../src/auth/token.util';

const prisma = new PrismaClient();

async function main() {
  const email = requireEnv('BOOTSTRAP_USER_EMAIL');
  const mt5Login = requireEnv('BOOTSTRAP_MT5_LOGIN');
  const mt5Server = requireEnv('BOOTSTRAP_MT5_SERVER');
  const currency = process.env.BOOTSTRAP_MT5_CURRENCY?.trim() || 'USD';

  const user = await prisma.user.upsert({
    where: { email },
    create: { email },
    update: {},
  });
  console.log(`user: ${user.email} (${user.id})`);

  const account = await prisma.tradingAccount.upsert({
    where: { platform_externalAccountId: { platform: 'MT5', externalAccountId: mt5Login } },
    create: {
      userId: user.id,
      platform: 'MT5',
      externalAccountId: mt5Login,
      broker: mt5Server,
      currency,
      displayName: `MT5 ${mt5Login} (${mt5Server})`,
    },
    update: { broker: mt5Server, currency },
  });
  console.log(`trading_account: ${account.displayName} (${account.id})`);

  // Production-readiness review, item 1 — bound to THIS account specifically,
  // not a single shared "mt5-collector-primary" credential every account
  // would otherwise share.
  const existing = await prisma.apiCredential.findFirst({
    where: { accountId: account.id, scope: 'collector', revokedAt: null },
  });

  if (existing) {
    console.log(
      `\nA collector token already exists for this account (prefix ${existing.tokenPrefix}). ` +
        `Not regenerating — reuse the value already in your collector's .env, ` +
        `or run "npm run create-token -- ${account.id}" to mint a new one and revoke this one.`,
    );
  } else {
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
    console.log(
      `\nCollector token created — shown ONCE, copy it now:\n\n  ${plaintext}\n\n` +
        `It will never be shown again; the server only stores its hash.`,
    );
  }

  console.log(`\nAdd to the collector's .env:`);
  console.log(`  COLLECTOR_ACCOUNT_ID=${account.id}`);
  console.log(`  COLLECTOR_API_BASE_URL=http://localhost:${process.env.PORT ?? 3000}`);
}

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${key} — set it in backend/.env`);
  }
  return value;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
