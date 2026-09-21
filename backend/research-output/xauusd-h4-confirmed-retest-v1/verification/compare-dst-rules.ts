/**
 * Verification pass — does the choice of broker DST rule matter for any stored
 * XAUUSD bar? Converts every stored bar's server wall clock to UTC under
 * three candidate rules and counts disagreements. Read-only.
 *
 *   IANA `EET`          EU rules (used by the research code)
 *   IANA `Asia/Beirut`  Lebanese rules
 *   fixed +2/+3 on US DST dates (`America/New_York` offset + 7h), the rule a
 *                       NY-close-aligned broker would use
 *
 * Run: cd backend && npx tsx research-output/xauusd-h4-confirmed-retest-v1/verification/compare-dst-rules.ts
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { wallClockToUtc, zoneOffsetMs } from '../../../src/research/confirmed-retest/time';

const HOUR = 3_600_000;

function usRuleToUtc(wallMs: number): number {
  // NY-close-aligned server = New York offset + 7h (UTC+2 when NY is EST, UTC+3 when EDT).
  const guess = wallMs - 2 * HOUR;
  const off = zoneOffsetMs('America/New_York', guess) + 7 * HOUR;
  return wallMs - off;
}

async function main() {
  const prisma = new PrismaClient();
  const out: Record<string, unknown> = {};
  try {
    for (const tf of ['M1', 'H4', 'D1']) {
      const rows = await prisma.$queryRawUnsafe<Array<{ st: bigint }>>(
        `SELECT (EXTRACT(EPOCH FROM open_time) * 1000)::bigint AS st FROM historical_candles WHERE symbol='XAUUSD' AND timeframe=$1::"CandleTimeframe" ORDER BY open_time`,
        tf,
      );
      let eetVsBeirut = 0;
      let eetVsUs = 0;
      let beirutErrors = 0;
      const eetVsBeirutExamples: string[] = [];
      const eetVsUsWeeks = new Set<string>();
      for (const r of rows) {
        const wall = Number(r.st);
        const eet = wallClockToUtc('EET', wall);
        let beirut: number | null = null;
        try {
          beirut = wallClockToUtc('Asia/Beirut', wall);
        } catch {
          beirutErrors += 1;
        }
        if (beirut !== null && beirut !== eet) {
          eetVsBeirut += 1;
          if (eetVsBeirutExamples.length < 5) eetVsBeirutExamples.push(new Date(wall).toISOString());
        }
        if (usRuleToUtc(wall) !== eet) {
          eetVsUs += 1;
          eetVsUsWeeks.add(new Date(wall).toISOString().slice(0, 10));
        }
      }
      out[tf] = {
        rows: rows.length,
        barsWhereEetAndAsiaBeirutDisagree: eetVsBeirut,
        asiaBeirutConversionErrors: beirutErrors,
        eetVsBeirutExamples,
        barsWhereEetAndUsRuleDisagree: eetVsUs,
        eetVsUsRuleDatesSample: [...eetVsUsWeeks].slice(0, 12),
        eetVsUsRuleDistinctDates: eetVsUsWeeks.size,
      };
    }
  } finally {
    await prisma.$disconnect();
  }
  const file = join(__dirname, 'dst-rule-comparison.json');
  writeFileSync(file, JSON.stringify({ generatedAtUtc: new Date().toISOString(), runtime: process.versions, results: out }, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
