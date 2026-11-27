/**
 * The image seal probe under row-level security (Postgres; pattern of test/e2e/engine-sql-rls-scope.test.ts).
 *
 * readImageSealProbe reads a page by (source, slug) and its chunks, so with GBRAIN_RLS_SCOPE_BINDING=1 it runs in a
 * scoped read transaction bound to the page's source, as readPageSnapshot and getChunks do. A test policy on `pages`
 * admits only the bound scopes, and every read runs after `SET LOCAL ROLE <role>` with no scope of its own, so the
 * probe's own binding is the only thing that lets it see its source.
 *
 * Protects:
 *   - the probe sees a sealed page of its own source (the binding is applied: an unscoped read admits nothing here);
 *   - a probe for a source other than the page's returns nothing, whichever source the caller is bound to.
 * Fails when the probe is read unscoped (it then sees no row under a policy that needs a bound scope).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const role = `gbrain_seal_probe_rls_${randomUUID().replaceAll('-', '')}`;
const POLICY = `${role}_pages`;

async function asRole<T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.executeRaw(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  });
}

(hasDatabase() ? describe : describe.skip)('image seal probe RLS scope', () => {
  let engine: PostgresEngine;
  let savedFlag: string | undefined;
  let hadRowSecurity = false;
  let openTables: string[] = [];

  beforeAll(async () => {
    engine = await setupDB();
    for (const [id, slug] of [['src-a', 'images/only-in-a'], ['src-b', 'images/only-in-b']] as const) {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      const res = await importFromContent(engine, slug, `---\ntype: concept\ntitle: Seal ${id}\n---\n\nA page in ${id}.`, { noEmbed: true, sourceId: id });
      expect(res.status).toBe('imported');
      // Sealed past the safe-chunk fence, which is what the probe asks for.
      await engine.executeRaw('UPDATE pages SET chunker_version = 4 WHERE source_id = $1 AND slug = $2', [id, slug]);
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

  test('the probe sees a sealed page of its own source through its own scope binding', async () => {
    expect(await asRole(engine, (tx) => tx.readImageSealProbe('src-a', 'images/only-in-a'))).toEqual({ has_visual: false });
    expect(await asRole(engine, (tx) => tx.readImageSealProbe('src-b', 'images/only-in-b'))).toEqual({ has_visual: false });
  });

  test('a probe for a page that lives in another source returns nothing', async () => {
    expect(await asRole(engine, (tx) => tx.readImageSealProbe('src-a', 'images/only-in-b'))).toBeNull();
    expect(await asRole(engine, (tx) => tx.readImageSealProbe('src-b', 'images/only-in-a'))).toBeNull();
  });
});
