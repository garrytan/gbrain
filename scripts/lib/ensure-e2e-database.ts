#!/usr/bin/env bun
/**
 * Create an isolated E2E database if it does not exist yet.
 *
 *   bun scripts/lib/ensure-e2e-database.ts <admin-url> <database-name>
 *
 * ci-local's single PgBouncer fronts postgres-1 only, so each E2E shard's
 * backend-matrix PgBouncer pass (scripts/e2e-backend-matrix.txt) gets its own
 * database there instead of racing shard 1's gbrain_test. The name must carry
 * "test" as a segment (the test/helpers/db-guard.ts floor).
 */
import postgres from '#postgres';

const [adminUrl, name] = process.argv.slice(2);
if (!adminUrl || !name || !/^[a-z0-9_]+$/.test(name) || !/(^|_)test(_|$)/.test(name)) {
  console.error('usage: ensure-e2e-database.ts <admin-url> <name matching [a-z0-9_]+ with a "test" segment>');
  process.exit(2);
}
const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (rows.length === 0) await sql.unsafe(`CREATE DATABASE ${name}`);
  console.log(`ensure-e2e-database: ${name} ready`);
} finally {
  await sql.end({ timeout: 5 });
}
