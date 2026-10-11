/**
 * #5227 (W14 P1.6, [R8]): `gbrain init` / `upgrade` no longer hang behind an
 * open transaction. The schema replay runs under a session-level
 * `lock_timeout` on the reserved DDL backend (restored afterwards), SQLSTATE
 * 55P03 becomes the typed `schema_lock_blocked` refusal naming the blocking
 * sessions sampled while the wait was active (query text redacted), a
 * transaction-wrapped migration binds the same wait with SET LOCAL, and the
 * RLS block skips tables whose RLS is already on, so a re-run takes no
 * ACCESS EXCLUSIVE lock for them.
 *
 * Postgres only: lock semantics do not exist on PGLite. Runs in the direct and
 * PgBouncer E2E passes; under the pooler the restored setting must never leak
 * to another pooled client.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine, getPostgresSchema } from '../../src/core/postgres-engine.ts';
import { runMigrationSQL } from '../../src/core/migrate.ts';
import { withSchemaLockTimeout } from '../../src/core/postgres-engine/schema-lock-timeout.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the E2E tier');

describe('#5227 schema DDL waits are bounded and typed', () => {
  let engine: PostgresEngine, url: string, close: () => Promise<void>;
  beforeAll(async () => { ({ engine, databaseUrl: url, close } = await isolatedPersistencePostgres(databaseUrl!, 'instance', 4)); }, 180_000);
  afterAll(async () => { await close(); });

  /** An open transaction holding a SHARE lock on `pages` from another session, named so the refusal can be checked for it. */
  async function blocker(run: (holder: ReturnType<typeof postgres>) => Promise<void>) {
    const holder = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'gbrain-test-blocker' } });
    try {
      await holder.unsafe('BEGIN');
      await holder.unsafe('LOCK TABLE pages IN SHARE MODE');
      await run(holder);
    } finally {
      await holder.unsafe('ROLLBACK').catch(() => {});
      await holder.end({ timeout: 5 });
    }
  }

  test('init under a blocker fails typed within the injected timeout, naming the blocking session without its query text', () => blocker(async () => {
    const started = Date.now();
    const error = await withEnv({ GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS: '2' }, () => engine.initSchema()).catch((e: Error) => e) as Error & Record<string, string>;
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(error).toMatchObject({ code: 'schema_lock_blocked', detail: 'replay' });
    expect(error.message).toContain('gbrain-test-blocker');
    expect(error.message).toMatch(/Blocked by pid \d+/);
    expect(error.message).toContain('idle in transaction');
    expect(error.message).not.toContain('sampled after the cancel');
    expect(error.message).not.toContain('LOCK TABLE');
    expect(error.suggestion).toContain('pg_terminate_backend');
    expect(error.suggestion).not.toContain('LOCK TABLE');
  }), 60_000);

  test('the session lock_timeout is set on the DDL connection and restored on release; the pool default is unchanged', async () => {
    const seen: string[] = [];
    const conn = { unsafe: async (query: string, params?: unknown[]) => { const rows = await engine.executeRaw(query, params as unknown[]); if (query === 'SHOW lock_timeout') seen.push((rows[0] as { lock_timeout: string }).lock_timeout); return rows; } };
    await engine.executeRaw("SET lock_timeout = '0'");
    await engine.withReservedConnection(async reserved => {
      const q = { unsafe: async (query: string, params?: unknown[]) => reserved.executeRaw(query, params as unknown[]) };
      const before = (await reserved.executeRaw('SHOW lock_timeout'))[0] as { lock_timeout: string };
      let during = '';
      await withSchemaLockTimeout(q, async () => { during = ((await reserved.executeRaw('SHOW lock_timeout'))[0] as { lock_timeout: string }).lock_timeout; }, { step: 'probe', timeoutMs: 1500 });
      const after = (await reserved.executeRaw('SHOW lock_timeout'))[0] as { lock_timeout: string };
      expect(during).toBe('1500ms');
      expect(after.lock_timeout).toBe(before.lock_timeout);
    }, { selfContained: true });
    expect(((await conn.unsafe('SHOW lock_timeout'))[0] as { lock_timeout: string }).lock_timeout).toBe('0');
    // A second, independent client sees the server default: nothing leaked past the connection that set it.
    const other = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try { expect(((await other.unsafe('SHOW lock_timeout'))[0] as unknown as { lock_timeout: string }).lock_timeout).toBe('0'); }
    finally { await other.end({ timeout: 5 }); }
  }, 60_000);

  test('a transaction-wrapped migration under a blocker fails with the same typed code (SET LOCAL inside the real transaction)', () => blocker(async () => {
    const migration = { version: 999_999, name: 'w14_p16_probe', sql: 'ALTER TABLE pages ADD COLUMN IF NOT EXISTS w14_probe_column INTEGER' };
    const error = await withEnv({ GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS: '1' }, () => runMigrationSQL(engine, migration, migration.sql)).catch((e: Error) => e) as Error & Record<string, string>;
    expect(error).toMatchObject({ code: 'schema_lock_blocked', detail: 'migration v999999' });
    expect((await engine.executeRaw("SELECT 1 FROM information_schema.columns WHERE table_name='pages' AND column_name='w14_probe_column'")).length).toBe(0);
  }), 60_000);

  test('the RLS block is idempotent: with RLS already on, a re-run issues no ENABLE and does not wait behind an open reader', () => blocker(async () => {
    const schema = getPostgresSchema(1024, 'probe-model');
    const start = schema.indexOf('DO $$\nDECLARE\n  has_bypass BOOLEAN;');
    const end = schema.indexOf('END $$;', start) + 'END $$;'.length;
    const block = schema.slice(start, end);
    expect(block).toContain('relrowsecurity');
    expect(block).toContain("'pages'");
    const before = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity");
    // The blocker holds SHARE on pages: an unconditional ENABLE on pages would need ACCESS EXCLUSIVE and hit the 1 s bound.
    await engine.withReservedConnection(async reserved => {
      await withSchemaLockTimeout({ unsafe: (query: string) => reserved.executeRaw(query) }, () => reserved.executeRaw(block), { step: 'rls', timeoutMs: 1000 });
    }, { selfContained: true });
    const after = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity");
    expect(after[0].n).toBe(before[0].n);
  }), 60_000);

  test('an unconditional ENABLE on pages would have blocked (the forced probe the conditional block avoids)', () => blocker(async () => {
    const error = await engine.withReservedConnection(async reserved => withSchemaLockTimeout({ unsafe: (query: string) => reserved.executeRaw(query) },
      () => reserved.executeRaw('ALTER TABLE pages ENABLE ROW LEVEL SECURITY'), { step: 'rls', timeoutMs: 1000 }), { selfContained: true }).catch((e: Error) => e) as Error & Record<string, string>;
    expect(error).toMatchObject({ code: 'schema_lock_blocked', detail: 'rls' });
  }), 60_000);
});
