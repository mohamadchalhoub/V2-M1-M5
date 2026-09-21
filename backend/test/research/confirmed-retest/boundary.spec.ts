// Spec §10 hard boundary: the research/watch code has no order path and no
// database writes. This is a static check over the actual source files, so
// adding an execution import later fails the build rather than a review.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const moduleDir = join(root, 'src/research/confirmed-retest');
const files = [
  ...readdirSync(moduleDir).filter((f) => f.endsWith('.ts')).map((f) => join(moduleDir, f)),
  join(root, 'scripts/confirmed-retest-study.ts'),
  join(root, 'scripts/confirmed-retest-watch.ts'),
  join(root, 'src/research/confirmed-retest-dashboard/confirmed-retest.controller.ts'),
];

const forbidden: Array<[RegExp, string]> = [
  [/from ['"][^'"]*autonomous[^'"]*['"]/, 'imports legacy autonomous execution code'],
  [/from ['"][^'"]*trend-breakout[^'"]*['"]/, 'imports h4-trend-h1-breakout code'],
  [/from ['"][^'"]*(executor|execution|slot-lock|emergency)[^'"]*['"]/i, 'imports execution code'],
  [/from ['"][^'"]*(telegram|bullmq|ioredis|jobs)[^'"]*['"]/, 'imports messaging/queue code'],
  [/\bfetch\(|from ['"](node:)?https?['"]|axios/, 'makes network calls'],
  [/MetaTrader|order_send|orderSend|placeOrder|submitOrder/i, 'references order submission'],
  [/prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/, 'writes through Prisma'],
  [/\$executeRaw/, 'executes raw SQL writes'],
  [/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|\w+\s+SET)/, 'contains SQL write statements'],
];

describe('no-order execution boundary', () => {
  it.each(files)('%s has no order path, network call or database write', (file) => {
    const source = readFileSync(file, 'utf8');
    const hits = forbidden.filter(([re]) => re.test(source)).map(([, why]) => why);
    expect(hits).toEqual([]);
  });

  it('the watch module declares no order execution', () => {
    expect(readFileSync(join(moduleDir, 'watch.ts'), 'utf8')).toMatch(/ORDER_EXECUTION = 'NONE'/);
  });
});
