/**
 * Verification pass — effective entry window of h4-trend-h1-breakout-v1's
 * backtest when it is fed stored candle times (broker-server wall clock)
 * as if they were UTC. Calls the strategy's REAL `isWithinEntryWindow`
 * unmodified; no strategy code is changed. Read-only, no database.
 *
 * Run: cd backend && npx tsx research-output/xauusd-h4-confirmed-retest-v1/verification/breakout-window-impact.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isWithinEntryWindow } from '../../../src/trend-breakout/schedule';
import { beirutStamp, wallClockToUtc } from '../../../src/research/confirmed-retest/time';

const samples = [
  { regime: 'winter (US standard, EU standard)', date: '2025-01-15' },
  { regime: 'US DST only (mismatch week)', date: '2025-03-19' },
  { regime: 'summer (US DST, EU DST)', date: '2025-07-16' },
];

const rows: Array<Record<string, unknown>> = [];
for (const s of samples) {
  const admittedTrueBeirutHours: string[] = [];
  for (let h = 0; h < 24; h++) {
    const storedDigits = Date.parse(`${s.date}T${String(h).padStart(2, '0')}:00:00.000Z`); // what Prisma returns as openTime
    const trueUtc = wallClockToUtc('EET', storedDigits);
    const trueBeirut = beirutStamp(trueUtc);
    if (isWithinEntryWindow(new Date(storedDigits))) admittedTrueBeirutHours.push(`${String(trueBeirut.hour).padStart(2, '0')}:00`);
  }
  rows.push({
    ...s,
    intendedWindowBeirut: '03:00-12:00',
    barOpensAdmittedByBacktest_inTrueBeirutTime: `${admittedTrueBeirutHours[0]} .. ${admittedTrueBeirutHours[admittedTrueBeirutHours.length - 1]} (${admittedTrueBeirutHours.length} hourly opens)`,
  });
}
writeFileSync(join(__dirname, 'breakout-window-impact.json'), JSON.stringify(rows, null, 2));
console.table(rows);
