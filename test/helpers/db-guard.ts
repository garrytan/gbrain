/**
 * Production guard for tests that run destructive SQL against DATABASE_URL.
 *
 * setupDB() TRUNCATEs every data table on whatever DATABASE_URL points at, and
 * run-e2e.sh deliberately preserves an exported DATABASE_URL, so a developer
 * with a production URL in their environment would wipe their real brain by
 * running the suite. Test files that connect a PostgresEngine directly, without
 * going through setupDB(), carry the same risk and must call this themselves.
 *
 * Refuse unless the database name identifies itself as a test database ("test"
 * as a word segment, e.g. gbrain_test, the CI/.env.testing.example convention),
 * or the operator explicitly opts the exact name in via GBRAIN_E2E_ALLOW_DB.
 *
 * Lives in its own leaf module so unit-directory tests can import it without
 * pulling in test/e2e/helpers.ts, which loads .env.testing and the engines at
 * import time. test/e2e/helpers.ts re-exports it for existing call sites.
 *
 * Pure: no connection is made.
 */
export function assertSafeE2eDatabaseUrl(
  url: string,
  env: Record<string, string | undefined> = process.env,
): void {
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`E2E guard: DATABASE_URL is not a parseable URL; refusing to run destructive setup.`);
  }
  if (!dbName) {
    throw new Error(`E2E guard: DATABASE_URL has no database name; refusing to run destructive setup.`);
  }
  if (/(^|[_-])test([_-]|$)/i.test(dbName)) return;
  if (env.GBRAIN_E2E_ALLOW_DB && env.GBRAIN_E2E_ALLOW_DB === dbName) return;
  throw new Error(
    `E2E guard: database "${dbName}" does not look like a test database ` +
    `(expected "test" as a name segment, e.g. gbrain_test). This test runs ` +
    `destructive SQL against it. If this is intentional, set ` +
    `GBRAIN_E2E_ALLOW_DB=${dbName} to opt in explicitly.`,
  );
}
