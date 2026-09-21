/**
 * Pure-logic V2 suites: strategy rules that depend on no database, no broker
 * and no clock.
 *
 * Deliberately separate from `vitest.config.ts`, which runs `prisma migrate
 * deploy` against the disposable test database in its globalSetup. These
 * suites need none of that, so keeping them runnable without infrastructure
 * means the rule set can be verified on any machine and in any order — and
 * that a failure here is unambiguously a rule failure rather than a
 * connection problem.
 */
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './',
    include: ['test/xauusd-m1m5/**/*.spec.ts'],
    // occupancy.spec.ts verifies a DATABASE constraint — that a composite
    // primary key serialises concurrent claims — so it needs a real Postgres
    // and belongs to the full suite, not here. Asserting that guarantee
    // against a mock would prove nothing about it.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/xauusd-m1m5/occupancy.spec.ts'],
    testTimeout: 20_000,
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
