// Runs ONCE for the whole test run, in a separate process from the spec
// files. Its only job is making sure the disposable test database's schema
// is current before any test connects to it.
import { config } from 'dotenv';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export default async function globalSetup() {
  const env = { ...process.env };
  config({ path: resolve(__dirname, '../.env.test'), override: true, processEnv: env });

  // Guard against running migrations anywhere but THIS project's disposable
  // test database. The name is v2-specific on purpose: several sibling
  // checkouts of this codebase exist on the same machine, one of which is
  // deployed and trading, and a test run that reached another project's
  // database would be unrecoverable. Widening this check is never the right
  // fix for a connection error.
  if (!env.DATABASE_URL?.includes('m1m5_v2_test')) {
    throw new Error(
      'Refusing to run migrations: DATABASE_URL does not point at this project\'s test database ' +
        '(expected a name containing "m1m5_v2_test"). Check backend/.env.test.',
    );
  }

  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
  });
}
