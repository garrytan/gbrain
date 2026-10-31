/**
 * #7632 on PGLite: every gbrain function that pins a search_path ends it with pg_temp, so a temp table named like a
 * purge or withdrawal ledger hides nothing from the guard that reads it. PGLite has one role, the owner, and before the
 * change its guards read the empty temp table and stored the purged write. The guards are otherwise as on master.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PINNED_FUNCTION_NAMES } from '../src/core/function-search-path.ts';

const PURGED_CLAIM = 'alice-example joined acme-example as cto';
const WITHDRAWN_CLAIM = 'alice-example lives in city-a';
const PURGED_TAKE = 'acme-example will double revenue';
const PURGED_HASH = 'deadbeefcafe00000000000000000002';
const SHADOWED = ['fact_purges', 'fact_withdrawals', 'take_purges', 'page_purges'];

describe('function search_path ends in pg_temp on PGLite (#7632)', () => {
  let engine: PGLiteEngine;
  let takesPage = 0;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const [page] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages (slug, type, title, compiled_truth) VALUES ('people/alice-example', 'person', 'a', 'x') RETURNING id`);
    takesPage = page!.id;
    await engine.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', '*', gbrain_fact_fingerprint($1))`, [PURGED_CLAIM]);
    await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', '*', gbrain_fact_fingerprint($1))`, [WITHDRAWN_CLAIM]);
    await engine.executeRaw(`INSERT INTO page_purges (source_id, content_hash, slug) VALUES ('default', $1, 'notes/purged-example')`, [PURGED_HASH]);
    await engine.executeRaw(`INSERT INTO take_purges (source_id, subject, claim_hash) VALUES ('default', '*', gbrain_fact_fingerprint($1))`, [PURGED_TAKE]);
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('every function that pins a search_path ends it with pg_temp, none is SECURITY DEFINER, and each is in PINNED_FUNCTION_NAMES', async () => {
    const rows = await engine.executeRaw<{ name: string; sig: string; setting: string; secdef: boolean }>(
      `SELECT p.proname AS name, p.oid::regprocedure::text AS sig, s.setting, p.prosecdef AS secdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL unnest(p.proconfig) AS s(setting) WHERE n.nspname = 'public' AND s.setting LIKE 'search_path=%' ORDER BY 1`);
    expect(rows.length).toBeGreaterThanOrEqual(35);
    expect(rows.filter(r => !r.setting.endsWith(', pg_temp') || r.secdef).map(r => r.sig)).toEqual([]);
    expect(rows.map(r => r.name).filter(name => !(PINNED_FUNCTION_NAMES as readonly string[]).includes(name))).toEqual([]);
  });

  test('another application\'s function in public pinning the old search_path keeps it: boots and the migration leave it, and doctor does not name it', async () => {
    const { functionSearchPathProblems } = await import('../src/commands/doctor/checks/function-search-path.ts');
    const { v277 } = await import('../src/core/schema-migrations/v277-function-search-path-pg-temp.ts');
    await engine.executeRaw(`CREATE FUNCTION public.app_example() RETURNS int LANGUAGE sql SET search_path = pg_catalog, public AS 'SELECT 1'`);
    try {
      await engine.initSchema();
      await v277.handler!(engine);
      expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
      const [fn] = await engine.executeRaw<{ config: string[] }>(`SELECT proconfig AS config FROM pg_proc WHERE proname = 'app_example'`);
      expect(fn!.config).toEqual(['search_path=pg_catalog, public']);
    } finally {
      await engine.executeRaw('DROP FUNCTION IF EXISTS public.app_example()');
    }
  }, 120_000);

  test('temp tables named like the ledgers hide nothing: purged writes are refused and a withdrawn fact is stamped', async () => {
    const attempt = (sql: string, params: unknown[]) => engine.executeRaw(sql, params).then(() => 'stored', (e: Error) => e.message.split(':')[0]);
    try {
      for (const ledger of SHADOWED) await engine.executeRaw(`CREATE TEMP TABLE ${ledger} (LIKE public.${ledger})`);
      const fact = await attempt(`INSERT INTO facts (fact, source) VALUES ($1, 'probe')`, [PURGED_CLAIM]);
      const page = await attempt(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ('notes/again-example', 'note', 't', 'x', $1)`, [PURGED_HASH]);
      const take = await attempt(`INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, $2, 'take', 'alice-example')`, [takesPage, PURGED_TAKE]);
      const [w] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (fact, source) VALUES ($1, 'probe') RETURNING id`, [WITHDRAWN_CLAIM]);
      const [stamped] = await engine.executeRaw<{ expired: boolean }>('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id = $1', [w!.id]);
      expect({ fact, page, take, withdrawn: stamped!.expired ? 'expired' : 'active' })
        .toEqual({ fact: 'purged_content', page: 'purged_content', take: 'purged_content', withdrawn: 'expired' });
    } finally {
      for (const ledger of SHADOWED) await engine.executeRaw(`DROP TABLE IF EXISTS pg_temp.${ledger}`);
    }
  });

  test('a procedure in public pinning the old search_path is left alone: boots and the migration still succeed, and doctor does not name it', async () => {
    const { functionSearchPathProblems } = await import('../src/commands/doctor/checks/function-search-path.ts');
    const { v277 } = await import('../src/core/schema-migrations/v277-function-search-path-pg-temp.ts');
    await engine.executeRaw(`CREATE PROCEDURE public.proc_example() LANGUAGE plpgsql SET search_path = pg_catalog, public AS $p$ BEGIN END $p$`);
    try {
      await engine.initSchema();
      await v277.handler!(engine);
      expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
      const [proc] = await engine.executeRaw<{ config: string[] }>(`SELECT proconfig AS config FROM pg_proc WHERE proname = 'proc_example'`);
      expect(proc!.config).toEqual(['search_path=pg_catalog, public']);
    } finally {
      await engine.executeRaw('DROP PROCEDURE IF EXISTS public.proc_example()');
    }
  }, 120_000);
});
