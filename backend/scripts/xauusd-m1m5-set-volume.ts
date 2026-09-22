/**
 * Sets this strategy's order volume, with an audit record.
 *
 *   node dist/scripts/xauusd-m1m5-set-volume.js <lots> [--by <who>] [--note <why>]
 *   (on the VPS:  bash deploy/m1m5.sh set-volume 0.03)
 *
 * A thin wrapper; the rules live in src/xauusd-m1m5/volume-setting.ts, where
 * they are tested. Takes effect on the next order with no restart: the
 * execution path reads the setting fresh every time.
 */
import { PrismaClient } from '@prisma/client';
import { V2_SL_USD, V2_STOP_RISK_CAP_PCT } from '../src/xauusd-m1m5/safety-constants';
import { setVolume } from '../src/xauusd-m1m5/volume-setting';

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (!args[0] || args[0].startsWith('--')) {
    console.error('usage: xauusd-m1m5-set-volume <lots> [--by <who>] [--note <why>]');
    return 2;
  }
  const accountId = process.env.XAUUSD_M1M5_ACCOUNT_ID?.trim();
  if (!accountId) {
    console.error('REFUSED: XAUUSD_M1M5_ACCOUNT_ID is not set, so there is no account to configure.');
    return 1;
  }

  const prisma = new PrismaClient();
  try {
    const result = await setVolume(prisma, {
      accountId,
      lots: Number(args[0]),
      changedBy: flag(args, '--by') ?? process.env.SUDO_USER ?? process.env.USER ?? 'operator',
      note: flag(args, '--note'),
    });
    if (!result.ok) {
      console.error(`REFUSED: ${result.reason}`);
      return 1;
    }
    console.log(`Volume set: ${result.previousLots === null ? '(default)' : result.previousLots} -> ${result.lots} lot.`);
    console.log(`  audit: ${result.provenance}`);
    console.log(
      `  at the $${V2_SL_USD} stop this risks $${result.stopRisk.toFixed(2)}` +
        (result.stopRiskPct === null
          ? ' (no equity reading yet to compare).'
          : ` = ${result.stopRiskPct.toFixed(3)}% of equity (per-trade cap ${V2_STOP_RISK_CAP_PCT}%).`),
    );
    if (result.aboveCap) {
      console.log('  WARNING: above the per-trade cap. Every order at this volume will be refused by the risk gate.');
    }
    console.log('Takes effect on the next signal. No restart needed.');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('set-volume failed:', err);
    process.exit(1);
  });
