/**
 * #6288 / #6352 (P2.3) behind transaction-mode PgBouncer, the pooler that drops gbrain's startup
 * `idle_in_transaction_session_timeout` (docker-compose.ci.yml IGNORE_STARTUP_PARAMETERS). The publish transaction's own
 * transaction-local bound still applies there: a publisher idle past it is ended by the server, nothing it wrote commits,
 * and because Postgres ends the whole session (the pooler's server connection), the transaction promise rejects even
 * while the body is still parked, the pool reconnects, and the next transaction runs. Skipped without the CI PgBouncer fixture (GBRAIN_PGBOUNCER_URL / GBRAIN_PGBOUNCER_DIRECT_URL).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { bindPublicationTimeouts, publicationTransaction } from '../../src/core/persistence/publication-deadline.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const pooled = process.env.GBRAIN_PGBOUNCER_URL;
const direct = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const available = Boolean(pooled && direct);
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && !available) throw new Error('The publication deadline twin requires the configured CI PgBouncer fixture.');
let home: string, database: string;
let admin: ReturnType<typeof postgres> | undefined;
let engine: PostgresEngine | undefined;

beforeAll(async () => {
  if (!available) return;
  assertSafeE2eDatabaseUrl(direct!);
  home = mkdtempSync(join(tmpdir(), 'gbrain-pub-deadline-pooled-'));
  database = `gbrain_test_pub_deadline_${randomUUID().replaceAll('-', '')}`;
  admin = postgres(direct!, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const url = new URL(pooled!);
  url.pathname = `/${database}`;
  engine = new PostgresEngine();
  await withEnv({ GBRAIN_HOME: home }, async () => { await engine!.connect({ database_url: url.toString(), poolSize: 2 }); await engine!.initSchema(); });
}, 120_000);

afterAll(async () => {
  if (engine) await withEnv({ GBRAIN_HOME: home }, () => engine!.disconnect());
  if (admin) { try { if (database) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); } }
  if (home) rmSync(home, { recursive: true, force: true });
});

test.skipIf(!available)('the transaction-local idle bound holds behind the pooler; the ended session is replaced and nothing commits', async () => {
  const db = engine!;
  const steps: string[] = [];
  const attempt = publicationTransaction(db, async tx => {
    await bindPublicationTimeouts(tx);
    const [shown] = await tx.executeRaw<{ v: string }>("SELECT current_setting('idle_in_transaction_session_timeout') AS v");
    steps.push(`bound=${shown!.v}`);
    await tx.executeRaw("SELECT set_config('idle_in_transaction_session_timeout','300ms',true)");
    await tx.executeRaw("INSERT INTO config(key,value) VALUES('p23.pooled','x')");
    steps.push('inserted');
    await new Promise(r => setTimeout(r, 1500));
    steps.push('woke');
    await tx.executeRaw('SELECT 1');
    steps.push('after');
    return 'committed';
  });
  const started = Date.now();
  await expect(attempt).rejects.toBeDefined();
  // The driver rejects the transaction when the server ends the session, while the body is still parked in its sleep.
  expect(Date.now() - started).toBeLessThan(1500);
  expect(steps).toEqual(['bound=5min', 'inserted']);
  const rows = await db.executeRaw<{ n: number | string }>("SELECT count(*) AS n FROM config WHERE key='p23.pooled'");
  expect(Number(rows[0]!.n)).toBe(0);
  expect(await db.transaction(async tx => (await tx.executeRaw<{ one: number }>('SELECT 1 AS one'))[0]!.one)).toBe(1);
}, 60_000);
