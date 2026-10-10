import { assertSafeE2eDatabaseUrl } from './db-guard.ts';
import { withEnv } from './with-env.ts';

export type TestBackend = 'pglite' | 'postgres';

export function requirePostgresTestDatabase(env: Record<string, string | undefined> = process.env): string {
  if (!env.DATABASE_URL) throw new Error('PostgreSQL test lane requires DATABASE_URL; refusing to skip its backend');
  assertSafeE2eDatabaseUrl(env.DATABASE_URL, env);
  return env.DATABASE_URL;
}

/** `postgres` (registerPostgresTests) and the E2E backend matrix passes (scripts/run-e2e.sh: direct and PgBouncer) select the Postgres arm only. */
const POSTGRES_ONLY_BACKENDS = new Set(['postgres', 'postgres-direct', 'pgbouncer']);

export function testBackends(env: Record<string, string | undefined> = process.env): TestBackend[] {
  if (env.GBRAIN_TEST_BACKEND !== undefined && POSTGRES_ONLY_BACKENDS.has(env.GBRAIN_TEST_BACKEND)) {
    requirePostgresTestDatabase(env);
    return ['postgres'];
  }
  if (env.GBRAIN_TEST_BACKEND !== undefined) throw new Error('Unknown GBRAIN_TEST_BACKEND; expected postgres, postgres-direct, pgbouncer or unset');
  return env.DATABASE_URL ? ['pglite', 'postgres'] : ['pglite'];
}

export async function registerPostgresTests(...loaders: Array<() => Promise<unknown>>): Promise<void> {
  requirePostgresTestDatabase();
  await withEnv({ GBRAIN_TEST_BACKEND: 'postgres' }, async () => {
    for (const load of loaders) await load();
  });
}
