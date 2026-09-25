/**
 * Operator command: resume TODAY's DAILY_CLOSED xauusd-sar session after an
 * operator/emergency flatten. Places no order. See src/xauusd-sar/operator-resume.ts.
 *
 * Usage (inside the SAR scheduler container): node dist/scripts/xauusd-sar-operator-resume.js
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { operatorResumeSession } from '../src/xauusd-sar/operator-resume';

async function main(): Promise<void> {
  const accountId = (
    process.env.XAUUSD_SAR_ACCOUNT_ID ??
    process.env.XAUUSD_M1M5_ACCOUNT_ID ??
    process.env.COLLECTOR_ACCOUNT_ID ??
    ''
  ).trim();
  if (!accountId) throw new Error('no account id configured');
  const prisma = new PrismaClient();
  try {
    const result = await operatorResumeSession(prisma as never, accountId, Date.now());
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ resumed: result.resumed, refusals: result.refusals, facts: result.facts }, null, 2));
    process.exitCode = result.resumed ? 0 : 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`operator resume failed: ${(err as Error).message}`);
  process.exit(1);
});
