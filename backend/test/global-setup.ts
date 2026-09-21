// Runs ONCE for the whole test run, in a separate process from the spec
// files. Its only job is making sure the disposable test database's schema
// is current before any test connects to it.
import { config } from 'dotenv';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export default async function globalSetup() {
  const env = { ...process.env };
  config({ path: resolve(__dirname, '../.env.test'), override: true, processEnv: env });

  if (!env.DATABASE_URL?.includes('autonomous_trading_test')) {
    throw new Error(
      'Refusing to run migrations: DATABASE_URL does not look like the test database. ' +
        'Check backend/.env.test.',
    );
  }

  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
  });
}
