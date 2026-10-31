/**
 * Every gbrain function that pins a search_path ends it with pg_temp, so a temp table or view named like a purge or
 * withdrawal ledger no longer hides it from the guard that reads it (#7632, src/core/function-search-path.ts).
 *
 * Before, the guards pinned `pg_catalog, public`, which leaves the caller's temporary schema first in the relation
 * search: any session could create an empty temp table named fact_purges (or take_purges, page_purges, fact_withdrawals,
 * page_segment_derivation_purges) and store a purged claim, take, page or derivation again, or save a withdrawn fact
 * active, as the owner or as a non-owner writer. The guards themselves are as on master (SECURITY INVOKER, same bodies,
 * same timing); a writer with no policy on a ledger still reads it empty under its own RLS (#7659), which this file does
 * not cover: its writer has policies on every table.
 * Run: DATABASE_URL=... bun test test/e2e/function-search-path-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION, runMigrations } from '../../src/core/migrate.ts';
import { derivationNeedles } from '../../src/core/page-body/segment-derive.ts';
import { v277 } from '../../src/core/schema-migrations/v277-function-search-path-pg-temp.ts';
import { PINNED_FUNCTION_NAMES } from '../../src/core/function-search-path.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;
type Outcome = { rows: Array<Record<string, unknown>> } | { code: string; message: string };

const PURGED_CLAIM = 'alice-example joined acme-example as cto';
const WITHDRAWN_CLAIM = 'alice-example lives in city-a';
const PURGED_TAKE = 'acme-example will double revenue';
const PURGED_HASH = 'deadbeefcafe00000000000000000001';
const SHA = `decode(repeat('ab', 32), 'hex')`;
const SHADOWED = ['fact_purges', 'fact_withdrawals', 'take_purges', 'page_purges', 'page_segment_derivation_purges'];
const GUARD_TRIGGERS = ['facts_guard_inserted', 'facts_preserve_withdrawal', 'facts_refuse_purged', 'page_segment_derivations_refuse_purging',
  'pages_refuse_purged', 'takes_refuse_purged'];

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const WRITER = `gbrain_test_path_writer_${suffix}`;
const scratch: string[] = [];
const createdRoles: string[] = [];
let admin: Sql | null = null;

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshBrain(): Promise<{ url: string; conn: Sql }> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  const name = `gbrain_test_path_${randomUUID().replaceAll('-', '')}`;
  await admin!.unsafe(`CREATE DATABASE ${name}`);
  scratch.push(name);
  const url = urlFor(name);
  const conn = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url });
  try { await engine.initSchema(); } finally { await engine.disconnect(); }
  return { url, conn };
}

/** Runs `fn` as `role` in one transaction that is rolled back; each `run` is its own savepoint. */
async function as<T>(conn: Sql, role: string, fn: (run: (sql: string, params?: unknown[]) => Promise<Outcome>) => Promise<T>): Promise<T> {
  const session = await conn.reserve();
  try {
    await session.unsafe('BEGIN');
    await session.unsafe(`SET LOCAL ROLE ${role}`);
    return await fn(async (sql, params) => {
      await session.unsafe('SAVEPOINT attempt');
      try {
        const rows = await session.unsafe(sql, params as never[]);
        await session.unsafe('RELEASE SAVEPOINT attempt');
        return { rows: [...rows] as Array<Record<string, unknown>> };
      } catch (error) {
        await session.unsafe('ROLLBACK TO SAVEPOINT attempt');
        const e = error as { code?: string; message?: string };
        return { code: String(e.code), message: String(e.message) };
      }
    });
  } finally {
    await session.unsafe('ROLLBACK').catch(() => {});
    session.release();
  }
}

const rowsOf = (o: Outcome) => ('rows' in o ? o.rows : (() => { throw new Error(`expected rows, got ${o.code}: ${o.message}`); })());
const outcome = (o: Outcome) => ('code' in o ? o.message.split(':')[0] : `stored ${o.rows.length}`);

async function capturingStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { value: await fn(), stderr }; } finally { process.stderr.write = write; }
}

/** SECURITY DEFINER functions, guard trigger timing and every pinned search_path in public. */
async function catalog(c: Sql) {
  const definers = await c.unsafe<Array<{ fn: string }>>(
    `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`);
  const triggers = await c.unsafe<Array<{ trigger: string; timing: string }>>(
    `SELECT tgname AS trigger, CASE WHEN (tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY($1::text[]) ORDER BY 1`, [GUARD_TRIGGERS]);
  const paths = await c.unsafe<Array<{ name: string; sig: string; setting: string }>>(
    `SELECT p.proname AS name, p.oid::regprocedure::text AS sig, s.setting FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL unnest(p.proconfig) AS s(setting) WHERE n.nspname = 'public' AND s.setting LIKE 'search_path=%' ORDER BY 1`);
  return {
    definers: definers.map(d => d.fn),
    triggers: triggers.map(t => ({ trigger: t.trigger, timing: t.timing })),
    pinned: paths.length,
    withoutTemp: paths.filter(p => !p.setting.endsWith(', pg_temp')).map(p => p.sig),
    unlisted: paths.filter(p => !(PINNED_FUNCTION_NAMES as readonly string[]).includes(p.name)).map(p => p.sig),
  };
}

/** Puts a brain back in the shape every brain had before #7632 (no pg_temp on any pinned path), at the version before v277. */
async function rewind(c: Sql): Promise<void> {
  await c.unsafe(`DO $$ DECLARE f RECORD; BEGIN
      FOR f IN SELECT p.oid::regprocedure AS sig, substr(s.setting, 13) AS path FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                CROSS JOIN LATERAL unnest(p.proconfig) AS s(setting) WHERE n.nspname = 'public' AND s.setting LIKE 'search_path=%, pg_temp' LOOP
        EXECUTE format('ALTER FUNCTION %s SET search_path = %s', f.sig, left(f.path, -9));
      END LOOP; END $$;
    UPDATE config SET value = '${v277.version - 1}' WHERE key = 'version';`);
}

describeE2E('a temp table or view named like a ledger hides nothing from the guards (#7632)', () => {
  let conn: Sql;
  let url: string;
  let owner = '';
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    admin = postgres(DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE ROLE ${WRITER} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    createdRoles.push(WRITER);
    ({ url, conn } = await freshBrain());
    [{ owner }] = await conn.unsafe<Array<{ owner: string }>>('SELECT current_user AS owner');
    // A non-owner writer with a policy on every RLS table, ledgers included: the guards refuse it exactly as the owner.
    await conn.unsafe(`GRANT USAGE ON SCHEMA public TO ${WRITER};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${WRITER};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${WRITER};
      DO $$ DECLARE t RECORD; BEGIN
        FOR t IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity LOOP
          EXECUTE format('CREATE POLICY gbrain_test_writer ON %s TO ${WRITER} USING (true) WITH CHECK (true)', t.rel);
        END LOOP; END $$`);
    for (const [key, slug] of [['takes', 'people/alice-example'], ['derived', 'notes/derivation-example']]) {
      const [row] = await conn.unsafe<Array<{ id: number }>>(`INSERT INTO pages (slug, type, title, compiled_truth) VALUES ($1, 'note', $1, 'x') RETURNING id`, [slug]);
      ids[key] = row!.id;
    }
    await conn.unsafe(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', '*', gbrain_fact_fingerprint($1))`, [PURGED_CLAIM]);
    await conn.unsafe(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', '*', gbrain_fact_fingerprint($1))`, [WITHDRAWN_CLAIM]);
    await conn.unsafe(`INSERT INTO page_purges (source_id, content_hash, slug) VALUES ('default', $1, 'notes/purged-example')`, [PURGED_HASH]);
    await conn.unsafe(`INSERT INTO take_purges (source_id, subject, claim_hash) VALUES ('default', '*', gbrain_fact_fingerprint($1))`, [PURGED_TAKE]);
    const { needles, patterns } = await derivationNeedles({ executeRaw: (sql: string, params?: unknown[]) => conn.unsafe(sql, params as never[]) } as never, [PURGED_CLAIM]);
    await conn.unsafe(`INSERT INTO page_segment_derivation_purges (request_id, source_id, needles, patterns, page_ids) VALUES ($1::uuid, 'default', $2::text[], $3::text[], $4::int[])`,
      [randomUUID(), needles, patterns, [ids.derived]]);
  }, 300_000);

  afterAll(async () => {
    await conn?.end();
    if (admin) {
      for (const name of scratch) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      for (const role of createdRoles) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await admin.end();
    }
  });

  /** Each guarded write the ledgers should stop, and what became of it. */
  async function guardedWrites(run: (sql: string, params?: unknown[]) => Promise<Outcome>) {
    const fact = outcome(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe') RETURNING id`, [PURGED_CLAIM]));
    const page = outcome(await run(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ('notes/again-example', 'note', 't', 'x', $1) RETURNING id`, [PURGED_HASH]));
    const take = outcome(await run(`INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, $2, 'take', 'alice-example') RETURNING id`, [ids.takes, PURGED_TAKE]));
    const derivation = outcome(await run(`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output)
      VALUES ($1, 'links', 1, 1, ${SHA}, ${SHA}, 'done', $2::jsonb) RETURNING 1 AS stored`, [ids.derived, JSON.stringify({ text: PURGED_CLAIM })]));
    const [w] = rowsOf(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe') RETURNING id`, [WITHDRAWN_CLAIM]));
    const [stamped] = rowsOf(await run('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id = $1', [w!.id]));
    return { fact, page, take, derivation, withdrawn: stamped!.expired ? 'expired' : 'active' };
  }
  const REFUSED = { fact: 'purged_content', page: 'purged_content', take: 'purged_content', derivation: 'stored 0', withdrawn: 'expired' };

  test('1. without a shadow, the owner and a non-owner writer have a purged fact, page and take refused, a purged derivation dropped and a withdrawn fact stamped', async () => {
    for (const role of [owner, WRITER]) {
      expect({ role, ...(await as(conn, role, guardedWrites)) }).toEqual({ role, ...REFUSED });
    }
  });

  test('2. a temp table or view named like each ledger hides nothing, for the owner and for a non-owner writer', async () => {
    for (const role of [owner, WRITER]) {
      for (const kind of ['TABLE', 'VIEW']) {
        const result = await as(conn, role, async run => {
          for (const ledger of SHADOWED) {
            rowsOf(await run(kind === 'TABLE' ? `CREATE TEMP TABLE ${ledger} (LIKE public.${ledger})` : `CREATE TEMP VIEW ${ledger} AS SELECT * FROM public.${ledger} WHERE false`));
          }
          return guardedWrites(run);
        });
        expect({ role, kind, ...result }).toEqual({ role, kind, ...REFUSED });
      }
    }
  });

  test('3. after a fresh install: no SECURITY DEFINER function, the guard triggers as on master, every pinned search_path ends in pg_temp', async () => {
    const c = await catalog(conn);
    expect(c.definers).toEqual([]);
    expect(c.triggers).toEqual([
      { trigger: 'facts_guard_inserted', timing: 'AFTER' },
      { trigger: 'facts_preserve_withdrawal', timing: 'BEFORE' },
      { trigger: 'facts_refuse_purged', timing: 'BEFORE' },
      { trigger: 'page_segment_derivations_refuse_purging', timing: 'BEFORE' },
      { trigger: 'pages_refuse_purged', timing: 'BEFORE' },
      { trigger: 'takes_refuse_purged', timing: 'BEFORE' },
    ]);
    expect(c.pinned).toBeGreaterThanOrEqual(35);
    expect(c.withoutTemp).toEqual([]);
    expect(c.unlisted).toEqual([]);
  });

  test('4. a brain at the version before, migrated (no schema blob replay), ends the same, and doctor passes only after', async () => {
    const { functionSearchPathProblems } = await import('../../src/commands/doctor/checks/function-search-path.ts');
    const brain = await freshBrain();
    const engine = new PostgresEngine();
    try {
      await rewind(brain.conn);
      const before = await catalog(brain.conn);
      expect(before.withoutTemp.length).toBe(before.pinned);
      await engine.connect({ database_url: brain.url });
      expect((await functionSearchPathProblems(engine)).functions.length).toBe(before.pinned);
      const { value, stderr } = await capturingStderr(() => runMigrations(engine));
      expect(value.current).toBe(LATEST_VERSION);
      expect(stderr).not.toContain('left without pg_temp');
      expect(await catalog(brain.conn)).toEqual(await catalog(conn));
      expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
    } finally {
      await engine.disconnect();
      await brain.conn.end();
    }
  }, 300_000);

  test('5. a migrating role that owns every table and function but one finishes, names that one, and the printed fix (as its owner) clears it; the migrating role then boots', async () => {
    const { functionSearchPathProblems } = await import('../../src/commands/doctor/checks/function-search-path.ts');
    const brain = await freshBrain();
    const migrator = `gbrain_test_path_migrator_${suffix}`;
    const other = `gbrain_test_path_other_${suffix}`;
    await admin!.unsafe(`CREATE ROLE ${migrator} LOGIN PASSWORD 'migrator' NOSUPERUSER BYPASSRLS; CREATE ROLE ${other} NOLOGIN NOSUPERUSER`);
    createdRoles.push(migrator, other);
    const engine = new PostgresEngine();
    try {
      await rewind(brain.conn);
      await brain.conn.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${migrator};
        DO $$ DECLARE r RECORD; BEGIN
          FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
                      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('e', 'a', 'i')) LOOP
            EXECUTE format('ALTER TABLE %s OWNER TO ${migrator}', r.rel);
          END LOOP;
          FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') LOOP
            EXECUTE format('ALTER ROUTINE %s OWNER TO ${migrator}', r.sig);
          END LOOP; END $$;
        ALTER FUNCTION gbrain_refuse_purged_fact() OWNER TO ${other}`);
      const asMigrator = new URL(brain.url);
      asMigrator.username = migrator;
      asMigrator.password = 'migrator';
      await engine.connect({ database_url: asMigrator.toString() });
      const { value, stderr } = await capturingStderr(() => runMigrations(engine));
      expect(value.current).toBe(LATEST_VERSION);
      expect(stderr).toContain('1 function(s) left without pg_temp on their search_path (gbrain_refuse_purged_fact())');
      expect((await catalog(brain.conn)).withoutTemp).toEqual(['gbrain_refuse_purged_fact()']);
      const { functions, fix } = await functionSearchPathProblems(engine);
      expect({ functions, fix }).toEqual({
        functions: ['gbrain_refuse_purged_fact()'],
        fix: ['ALTER FUNCTION gbrain_refuse_purged_fact() SET search_path = pg_catalog, public, pg_temp;'],
      });
      await brain.conn.unsafe(`SET ROLE ${other}; ${fix.join('\n')} RESET ROLE;`);
      expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
      await engine.initSchema();
      expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
      expect((await catalog(brain.conn)).withoutTemp).toEqual([]);
    } finally {
      await engine.disconnect().catch(() => {});
      await brain.conn.end();
    }
  }, 300_000);

  test('6. a brain at the latest version that boots again (schema blob replay, no migration) keeps pg_temp on every pinned path', async () => {
    const engine = new PostgresEngine();
    try {
      await engine.connect({ database_url: url });
      const { value } = await capturingStderr(() => runMigrations(engine));
      expect(value.applied).toBe(0);
      const before = await catalog(conn);
      await engine.initSchema();
      expect(await catalog(conn)).toEqual(before);
    } finally {
      await engine.disconnect();
    }
  }, 300_000);

  test('7. v277 refuses with schema_lock_blocked while another session holds a function it alters, and finishes after', async () => {
    const { withEnv } = await import('../helpers/with-env.ts');
    const engine = new PostgresEngine();
    const holder = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await conn.unsafe('ALTER FUNCTION gbrain_try_jsonb(text) SET search_path = pg_catalog, public');
      await engine.connect({ database_url: url });
      const session = await holder.reserve();
      try {
        await session.unsafe(`BEGIN; ALTER FUNCTION gbrain_try_jsonb(text) SET statement_timeout = '1min'`);
        const error = await withEnv({ GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS: '1' }, () => v277.handler!(engine).then(() => null, (e: unknown) => e));
        expect(error).toMatchObject({ code: 'schema_lock_blocked', detail: 'v277 search_path' });
        expect((await catalog(conn)).withoutTemp).toEqual(['gbrain_try_jsonb(text)']);
      } finally {
        await session.unsafe('ROLLBACK');
        session.release();
      }
      await withEnv({ GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS: '1' }, () => v277.handler!(engine));
      expect((await catalog(conn)).withoutTemp).toEqual([]);
    } finally {
      await holder.end();
      await engine.disconnect();
    }
  }, 120_000);

  for (const [entry, migrate] of [
    ['initSchema', (engine: PostgresEngine) => engine.initSchema()],
    ['runMigrations (the locked apply-migrations and upgrade path)', (engine: PostgresEngine) => runMigrations(engine)],
  ] as const) {
    test(`8. an upgrade through ${entry} whose migrations re-create guard functions and then fail at v276 still leaves pg_temp on every pinned path`, async () => {
      const brain = await freshBrain();
      const engine = new PostgresEngine();
      try {
        await brain.conn.unsafe(`DROP INDEX persistence_requests_foreground_committed;
          CREATE TABLE persistence_requests_foreground_committed (x int);
          UPDATE config SET value = '263' WHERE key = 'version';`);
        await engine.connect({ database_url: brain.url });
        const { value: failure } = await capturingStderr(() => migrate(engine).then(() => null, (e: unknown) => e));
        expect(String((failure as Error | null)?.message)).toContain('Index persistence_requests_foreground_committed is not valid');
        const [version] = await brain.conn.unsafe<Array<{ value: string }>>(`SELECT value FROM config WHERE key = 'version'`);
        expect(version!.value).toBe('275');
        expect((await catalog(brain.conn)).withoutTemp).toEqual([]);
      } finally {
        await engine.disconnect();
        await brain.conn.end();
      }
    }, 300_000);
  }

  test('9. a migration run at the latest version (nothing pending) still puts pg_temp back on a function a failed earlier run left without it', async () => {
    const brain = await freshBrain();
    const engine = new PostgresEngine();
    try {
      await brain.conn.unsafe('ALTER FUNCTION gbrain_refuse_purged_fact() SET search_path = pg_catalog, public');
      expect((await catalog(brain.conn)).withoutTemp).toEqual(['gbrain_refuse_purged_fact()']);
      await engine.connect({ database_url: brain.url });
      const { value } = await capturingStderr(() => runMigrations(engine));
      expect(value).toEqual({ applied: 0, current: LATEST_VERSION });
      expect((await catalog(brain.conn)).withoutTemp).toEqual([]);
    } finally {
      await engine.disconnect();
      await brain.conn.end();
    }
  }, 300_000);
});
