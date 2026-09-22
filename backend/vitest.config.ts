import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS's DI resolves constructor-injected dependencies (e.g. PrismaService)
// via TypeScript's emitDecoratorMetadata + reflect-metadata. Vitest's default
// transform is esbuild, which — same as tsx, which caused a real bug earlier
// in this project (CollectorTokenGuard's injected PrismaService came back
// undefined) — silently drops that metadata. SWC's decoratorMetadata option
// is the fix; this is NestJS's own documented recipe for Vitest.
export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.spec.ts'],
    // Excluded because the behaviour they assert is deliberately gone from
    // THIS project, not because they are flaky or unmaintained.
    //
    // Both suites drive the retired `xauusd-m1-rsi-retest-extremes-v1` entry
    // pipeline end to end: they set XAUUSD_RSI_EXECUTION_MODE=DEMO and assert
    // that signals are evaluated, slots claimed and orders queued. §2 of the
    // v2 specification requires every earlier entry route to be disabled in
    // this copy, so `getRsiExecutionMode()` now returns OFF in code and that
    // pipeline cannot queue anything. Verified by experiment: with the gate
    // temporarily reverted both files pass 41/41; with it in place 26 of
    // those 41 fail, all of them on "no order was queued".
    //
    // They are excluded rather than deleted (the strategy's code, tests and
    // history are retained and still readable) and rather than rewritten to
    // assert OFF (which would duplicate what the replacement suite already
    // proves, and would destroy their value as the record of how that
    // pipeline behaved when it was live).
    //
    // The replacement is `test/xauusd-m1m5/legacy-entries-disabled.spec.ts`,
    // which asserts the property that actually matters here: that no legacy
    // gate can reach an active mode whatever the environment says.
    //
    // Re-enabling one of those strategies means editing its mode getter, and
    // this exclusion should be removed in the same change.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'test/xauusd-rsi/execution-e2e.spec.ts',
      'test/xauusd-rsi/two-slot.spec.ts',
    ],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts', './test/setup-telegram-mock.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // All spec files share one disposable Postgres instance and truncate
    // it between tests — running spec files in parallel would race.
    fileParallelism: false,
    // A corollary worth stating, because it cost real time to rediscover:
    // this serialisation holds only WITHIN one vitest process. Two vitest
    // commands running at once — a full suite in one terminal and a single
    // spec file in another — share the one Postgres and truncate it under
    // each other, producing "record not found" and null-row failures that
    // move between runs and vanish when either is run alone. Run one suite at
    // a time against this database.
  },
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
      module: { type: 'es6' },
    }),
  ],
});
