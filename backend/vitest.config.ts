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
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts', './test/setup-telegram-mock.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // All spec files share one disposable Postgres instance and truncate
    // it between tests — running spec files in parallel would race.
    fileParallelism: false,
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
