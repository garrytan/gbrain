/**
 * Engine-sql RLS isolation under a real non-owner NOBYPASSRLS role
 * (refactor wave 1, EO4; pattern of test/e2e/shared-skills-rls.test.ts).
 *
 * The one W1-core read that was RLS-scoped on master is the CJK keyword
 * fallback, now `engine-sql/cjk-search.ts` taking a `ScopedRead`. With
 * GBRAIN_RLS_SCOPE_BINDING=1 the Postgres engine binds `app.scopes` inside the
 * read's scoped transaction. A test policy on `pages` admits only the bound
 * scopes; every read runs inside `engine.transaction()` after
 * `SET LOCAL ROLE <role>` (so it works through transaction-mode PgBouncer
 * too), which makes the scoped read a savepoint on that connection.
 *
 *   - cross-source denial: a src-a read never returns src-b rows, and with
 *     the binding off the policy admits nothing (the rows come from the
 *     binding, not from the superuser);
 *   - concurrent-request isolation: interleaved reads for two sources on two
 *     connections each see only their own source;
 *   - nested rollback restoration: the outer transaction's `app.scopes`
 *     survives the scoped read, whether the read commits or its savepoint rolls back;
 *   - connection reuse: after many scoped reads on a one-connection pool, the
 *     pooled connection carries no `app.scopes`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const backend = process.env.GBRAIN_TEST_BACKEND ?? 'postgres-direct';
const QUERY = '検証';
const role = `gbrain_engine_sql_rls_${randomUUID().replaceAll('-', '')}`;
const POLICY = `${role}_pages`;

async function asRole<T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>, scopes?: string): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.executeRaw(`SET LOCAL ROLE ${role}`);
    if (scopes !== undefined) await tx.executeRaw(`SELECT set_config('app.scopes', $1, true)`, [scopes]);
    return fn(tx);
  });
}

async function sourcesSeen(tx: BrainEngine, sourceId?: string): Promise<string[]> {
  const hits = await tx.searchKeyword(QUERY, sourceId ? { sourceId } : {});
  return [...new Set(hits.map((h) => String(h.source_id)))].sort();
}

(hasDatabase() ? describe : describe.skip)(`engine-sql RLS scope isolation [${backend}]`, () => {
  let engine: PostgresEngine;
  let savedFlag: string | undefined;
  let hadRowSecurity = false;
  let openTables: string[] = [];

  beforeAll(async () => {
    engine = await setupDB();
    for (const id of ['src-a', 'src-b']) {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      const md = `---\ntype: concept\ntitle: RLS ${id}\n---\n\n多言語対応のシステムを再度検証します。${id}`;
      const res = await importFromContent(engine, `originals/rls-${id}`, md, { noEmbed: true, sourceId: id });
      expect(res.status).toBe('imported');
    }
    const [state] = await engine.executeRaw<{ rowsecurity: boolean }>(
      `SELECT rowsecurity FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'pages'`);
    hadRowSecurity = state.rowsecurity;
    await engine.executeRaw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await engine.executeRaw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await engine.executeRaw(
      `CREATE POLICY ${POLICY} ON pages FOR SELECT TO ${role}
         USING (current_setting('app.scopes', true) = '*'
                OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')))`);
    await engine.executeRaw('ALTER TABLE pages ENABLE ROW LEVEL SECURITY');
    // Every other RLS-enabled table (the schema's auto-RLS default) opens to
    // the role, so the pages policy is the only thing that filters.
    openTables = (await engine.executeRaw<{ t: string }>(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema() AND rowsecurity AND tablename <> 'pages'`)).map((r) => r.t);
    for (const t of openTables) await engine.executeRaw(`CREATE POLICY ${role}_open ON ${t} FOR SELECT TO ${role} USING (true)`);
    savedFlag = process.env.GBRAIN_RLS_SCOPE_BINDING;
    process.env.GBRAIN_RLS_SCOPE_BINDING = '1';
  }, 120_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.GBRAIN_RLS_SCOPE_BINDING;
    else process.env.GBRAIN_RLS_SCOPE_BINDING = savedFlag;
    if (engine) {
      await engine.executeRaw(`DROP POLICY IF EXISTS ${POLICY} ON pages`);
      for (const t of openTables) await engine.executeRaw(`DROP POLICY IF EXISTS ${role}_open ON ${t}`);
      if (!hadRowSecurity) await engine.executeRaw('ALTER TABLE pages DISABLE ROW LEVEL SECURITY');
      await engine.executeRaw(`DROP OWNED BY ${role}`);
      await engine.executeRaw(`DROP ROLE ${role}`);
    }
    await teardownDB();
  });

  test('the role is a real non-owner NOBYPASSRLS role and the owner sees both sources', async () => {
    const effective = await asRole(engine, (tx) => tx.executeRaw<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'));
    expect(effective).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect(await sourcesSeen(engine)).toEqual(['src-a', 'src-b']);
  });

  test('cross-source denial: a scoped read sees only its source; unbound scopes admit nothing', async () => {
    expect(await asRole(engine, (tx) => sourcesSeen(tx, 'src-a'))).toEqual(['src-a']);
    expect(await asRole(engine, (tx) => sourcesSeen(tx, 'src-b'))).toEqual(['src-b']);
    expect(await asRole(engine, (tx) => sourcesSeen(tx))).toEqual(['src-a', 'src-b']);
    process.env.GBRAIN_RLS_SCOPE_BINDING = '0';
    try {
      expect(await asRole(engine, (tx) => sourcesSeen(tx, 'src-a'), '')).toEqual([]);
    } finally {
      process.env.GBRAIN_RLS_SCOPE_BINDING = '1';
    }
  });

  test('concurrent-request isolation: interleaved reads for two sources stay separate', async () => {
    const reads = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 'src-a' : 'src-b'));
    const seen = await Promise.all(reads.map((id) => asRole(engine, (tx) => sourcesSeen(tx, id))));
    expect(seen).toEqual(reads.map((id) => [id]));
  });

  test('nested rollback restoration: the outer app.scopes survives a committed and a rolled-back scoped read', async () => {
    const after = await asRole(engine, async (tx) => {
      expect(await sourcesSeen(tx, 'src-a')).toEqual(['src-a']);
      const [{ scopes }] = await tx.executeRaw<{ scopes: string }>(`SELECT current_setting('app.scopes', true) AS scopes`);
      const failed = await tx.transaction(async (inner) => {
        await inner.executeRaw(`SELECT set_config('app.scopes', 'src-a', true)`);
        throw new Error('inner rollback probe');
      }).then(() => null, (e: unknown) => e);
      expect((failed as Error).message).toBe('inner rollback probe');
      const [{ scopes: restored }] = await tx.executeRaw<{ scopes: string }>(`SELECT current_setting('app.scopes', true) AS scopes`);
      return { scopes, restored };
    }, 'src-b');
    expect(after).toEqual({ scopes: 'src-b', restored: 'src-b' });
  });

  test('connection reuse: a one-connection pool carries no app.scopes after scoped reads', async () => {
    const single = new PostgresEngine();
    await single.connect({ engine: 'postgres', database_url: process.env.DATABASE_URL!, poolSize: 1 });
    try {
      for (const id of ['src-a', 'src-b', 'src-a']) {
        expect(await asRole(single, (tx) => sourcesSeen(tx, id))).toEqual([id]);
      }
      const [{ scopes, who }] = await single.executeRaw<{ scopes: string | null; who: string }>(
        `SELECT current_setting('app.scopes', true) AS scopes, current_user AS who`);
      expect(scopes ?? '').toBe('');
      expect(who).not.toBe(role);
    } finally {
      await single.disconnect();
    }
  });
});
