/**
 * #7637: the derived-state maintainer triggers run SECURITY INVOKER and read or write tables other than the one being
 * written. A role that neither owns those tables nor bypasses RLS, with write policies on the written table but none on
 * the maintainer's, read them empty and did nothing (a deleted page kept its retrieval rows, a soft-deleted page its atom
 * scan state, a tag left the page revision alone, a version row got NULL trust and attribution, a retitled page lost its
 * timeline entries from search) or failed with a raw RLS error (the projection queue, the trust generation).
 *
 * Contract: each maintainer refuses with writer_coordinator_required (unreadable_state, the v278 refusal) when RLS
 * applies to the caller on a table it needs and no permissive policy of the caller covers a command it runs there. The
 * owner, a role that bypasses RLS and a role holding the policies docs/ENGINES.md lists (applied verbatim) keep exactly
 * the derived state they kept before. The owner arm runs on PGLite and Postgres (PGLite has no roles); the role arms run
 * on Postgres through test/e2e/derived-state-maintainers-7637-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { databaseRefusal } from '../src/core/persistence/publication-failure.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: Array<{ name: string; engine: BrainEngine }> = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-7637-db-'));
let closePostgres: (() => Promise<void>) | undefined;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const SCOPED = `gbrain_maint_7637_${suffix}`;
const BYPASS = `gbrain_maint_bypass_7637_${suffix}`;
const UNREADABLE = /writer_coordinator_required: writer state is unreadable to this database role/;
const ROLLBACK = 'maintainer-probe-rollback';
/** The tables the maintainers read or write besides the one being written. */
const MAINTAINER_TABLES = ['page_retrievals', 'extract_atoms_page_state', 'page_projection_jobs', 'trust_policy_state', 'timeline_entries', 'pages', 'sources'];

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push({ name: 'pglite', engine });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push({ name: 'postgres', engine: pg.engine }); closePostgres = pg.close;
  }
}, 180_000);
afterAll(async () => {
  for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

interface Seed { pageId: number; revision: string }
/** A page in 'default' with a retrieval row, atom scan state, a timeline entry and a recorded writer, written as the owner. */
async function seedPage(engine: BrainEngine): Promise<Seed> {
  const slug = `notes/maintainer-${randomUUID().slice(0, 8)}`;
  const [page] = await engine.transaction(async tx => {
    await tx.executeRaw(`SELECT set_config('gbrain.write_principal_kind','application',true), set_config('gbrain.write_principal_id','probe-writer',true)`);
    return tx.executeRaw<{ id: number; revision: string }>(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,content_hash)
      VALUES('default',$1,'note','Seed','body',repeat('a',64)) RETURNING id, knowledge_revision::text AS revision`, [slug]);
  });
  await engine.executeRaw(`INSERT INTO page_retrievals(page_id,last_retrieved_at) VALUES($1,now())`, [page!.id]);
  await engine.executeRaw(`INSERT INTO extract_atoms_page_state(source_incarnation,page_id,content_hash)
    SELECT incarnation,$1,repeat('a',64) FROM sources WHERE id='default'`, [page!.id]);
  await engine.executeRaw(`INSERT INTO timeline_entries(page_id,date,summary,detail) VALUES($1,'2026-01-02','zebrafish sighting','')`, [page!.id]);
  return { pageId: page!.id, revision: page!.revision };
}

interface Maintainer {
  fn: string;
  /** The maintainer table a scoped role holds no policy on in the refusal case. */
  hidden: string;
  op: (seed: Seed) => [string, unknown[]];
  /** Another trigger on the same table and event, disabled so the refusal is this maintainer's own. */
  isolate?: string;
  /** A deferred constraint trigger: fire it before the probe. */
  deferred?: boolean;
  /** Read as the owner after the write; `derived` is the state the maintainer keeps. */
  probe: (seed: Seed) => [string, unknown[]];
  derived: Record<string, unknown>;
}

const MAINTAINERS: Maintainer[] = [
  { fn: 'gbrain_forget_page_retrievals', hidden: 'page_retrievals',
    op: s => ['DELETE FROM pages WHERE id=$1', [s.pageId]],
    probe: s => ['SELECT count(*)::int AS retrievals FROM page_retrievals WHERE page_id=$1', [s.pageId]],
    derived: { retrievals: 0 } },
  { fn: 'gbrain_clear_atom_page_state', hidden: 'extract_atoms_page_state',
    op: s => ['UPDATE pages SET deleted_at=now() WHERE id=$1', [s.pageId]],
    probe: s => ['SELECT count(*)::int AS atom_state FROM extract_atoms_page_state WHERE page_id=$1', [s.pageId]],
    derived: { atom_state: 0 } },
  { fn: 'gbrain_advance_tag_revision', hidden: 'pages',
    op: s => [`INSERT INTO tags(page_id,tag,tag_source) VALUES($1,'probe-tag','added')`, [s.pageId]],
    probe: s => ['SELECT knowledge_revision::text <> $2 AS revision_advanced FROM pages WHERE id=$1', [s.pageId, s.revision]],
    derived: { revision_advanced: true } },
  { fn: 'gbrain_snapshot_version_trust', hidden: 'pages', isolate: 'page_versions_write_attribution',
    op: s => [`INSERT INTO page_versions(page_id,compiled_truth,knowledge_revision) VALUES($1,'v1',$2::uuid)`, [s.pageId, s.revision]],
    probe: s => ['SELECT trust_tier FROM page_versions WHERE page_id=$1', [s.pageId]],
    derived: { trust_tier: 'unknown' } },
  { fn: 'gbrain_stamp_version_attribution', hidden: 'pages', isolate: 'page_versions_trust_snapshot',
    op: s => [`INSERT INTO page_versions(page_id,compiled_truth,knowledge_revision) VALUES($1,'v1',$2::uuid)`, [s.pageId, s.revision]],
    probe: s => ['SELECT write_principal_kind, write_principal_id FROM page_versions WHERE page_id=$1', [s.pageId]],
    derived: { write_principal_kind: 'application', write_principal_id: 'probe-writer' } },
  { fn: 'update_page_search_vector', hidden: 'timeline_entries',
    op: s => [`UPDATE pages SET title='Retitled' WHERE id=$1`, [s.pageId]],
    probe: s => [`SELECT search_vector @@ to_tsquery('english','zebrafish') AS timeline_indexed FROM pages WHERE id=$1`, [s.pageId]],
    derived: { timeline_indexed: true } },
  { fn: 'gbrain_queue_page_projection', hidden: 'page_projection_jobs',
    op: s => [`UPDATE pages SET compiled_truth='new body' WHERE id=$1`, [s.pageId]],
    probe: s => [`SELECT count(*)::int AS queued FROM page_projection_jobs j JOIN sources src ON src.incarnation=j.source_incarnation
      JOIN pages p ON p.source_id=src.id AND p.slug=j.slug WHERE p.id=$1 AND j.revision=p.knowledge_revision`, [s.pageId]],
    derived: { queued: 1 } },
  { fn: 'gbrain_bump_trust_generation', hidden: 'trust_policy_state', deferred: true,
    op: () => [`INSERT INTO config(key,value) VALUES($1,'1')`, [`trust.probe_${randomUUID().slice(0, 8)}`]],
    probe: () => [`SELECT generation > COALESCE(NULLIF(current_setting('gbrain.probe_generation', true), ''), '0')::bigint AS generation_bumped
      FROM trust_policy_state WHERE id=1`, []],
    derived: { generation_bumped: true } },
];

interface Outcome { result: string; derived?: Record<string, unknown>; error?: unknown }
/**
 * Runs one maintainer's write in a transaction that always rolls back: as `role` when given (with `settings`), then
 * the probe as the owner. `result` is 'ok' or the error message.
 */
async function run(engine: BrainEngine, m: Maintainer, seed: Seed, opts: { role?: string; settings?: Record<string, string> } = {}): Promise<Outcome> {
  let derived: Record<string, unknown> | undefined;
  try {
    await engine.transaction(async tx => {
      if (m.isolate) await tx.executeRaw(`ALTER TABLE page_versions DISABLE TRIGGER ${m.isolate}`);
      if (m.deferred) {
        const [state] = await tx.executeRaw<{ generation: string }>('SELECT generation::text AS generation FROM trust_policy_state WHERE id=1');
        await tx.executeRaw(`SELECT set_config('gbrain.probe_generation',$1,true)`, [state!.generation]);
      }
      if (opts.role) await tx.executeRaw(`SET LOCAL ROLE ${opts.role}`);
      for (const [key, value] of Object.entries(opts.settings ?? {})) await tx.executeRaw('SELECT set_config($1,$2,true)', [key, value]);
      await tx.executeRaw(...m.op(seed));
      if (m.deferred) await tx.executeRaw('SET CONSTRAINTS ALL IMMEDIATE');
      if (opts.role) await tx.executeRaw('RESET ROLE');
      [derived] = await tx.executeRaw<Record<string, unknown>>(...m.probe(seed));
      throw new Error(ROLLBACK);
    });
    return { result: 'unreachable' };
  } catch (error) {
    const message = (error as Error).message;
    return message === ROLLBACK ? { result: 'ok', derived } : { result: message, error };
  }
}

describe('owner behaviour is unchanged', () => {
  for (const m of MAINTAINERS) {
    test(`${m.fn}: the owner keeps the derived state`, async () => {
      for (const { name, engine } of engines) {
        expect(await run(engine, m, await seedPage(engine)), `${name} ${m.fn}`).toEqual({ result: 'ok', derived: m.derived });
      }
    });
  }
});

/** The SQL between the maintainer recipe markers in docs/ENGINES.md, for `role`. */
function docsRecipe(role: string): string {
  // test-reads-source-ok[structural]: the operator recipe is applied verbatim, so the documented policies are the tested ones.
  const doc = readFileSync(new URL('../docs/ENGINES.md', import.meta.url), 'utf8');
  const block = /<!-- gbrain:maintainer-rls-recipe:begin[^>]*-->\s*```sql\n([\s\S]*?)```\s*<!-- gbrain:maintainer-rls-recipe:end -->/.exec(doc);
  if (!block) throw new Error('docs/ENGINES.md has no maintainer-rls-recipe block');
  return block[1]!.replaceAll('<writer-role>', role);
}

(backends.includes('postgres') ? describe : describe.skip)('a scoped writer without policies on the maintainer tables (Postgres)', () => {
  let engine: BrainEngine;
  let tables: string[] = [];
  const as = { role: SCOPED };
  /** Open policies for the scoped role on every table except `hidden`. */
  async function policies(hidden: string[]) {
    for (const table of tables) {
      await engine.executeRaw(`DROP POLICY IF EXISTS ${SCOPED}_open ON ${table}`);
      if (hidden.includes(table)) continue;
      await engine.executeRaw(`CREATE POLICY ${SCOPED}_open ON ${table} FOR ALL TO ${SCOPED} USING (true) WITH CHECK (true)`);
    }
  }

  beforeAll(async () => {
    engine = engines.find(e => e.name === 'postgres')!.engine;
    for (const role of [SCOPED, BYPASS]) {
      await engine.executeRaw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER ${role === BYPASS ? 'BYPASSRLS' : 'NOBYPASSRLS'}`);
      await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await engine.executeRaw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
      await engine.executeRaw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    }
    for (const table of MAINTAINER_TABLES) await engine.executeRaw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    tables = (await engine.executeRaw<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map(r => r.t);
    const [effective] = await engine.transaction(async tx => {
      await tx.executeRaw(`SET LOCAL ROLE ${SCOPED}`);
      return tx.executeRaw<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    });
    expect(effective).toEqual({ rolsuper: false, rolbypassrls: false });
  }, 60_000);
  afterAll(async () => {
    if (!engine) return;
    for (const role of [SCOPED, BYPASS]) {
      await engine.executeRaw(`DROP OWNED BY ${role}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  test('with a policy on every table the scoped role keeps the derived state', async () => {
    await policies([]);
    for (const m of MAINTAINERS) expect(await run(engine, m, await seedPage(engine), as), m.fn).toEqual({ result: 'ok', derived: m.derived });
  });

  for (const m of MAINTAINERS) {
    test(`${m.fn}: no policy on ${m.hidden} refuses the write instead of leaving the derived state stale`, async () => {
      await policies([m.hidden]);
      const outcome = await run(engine, m, await seedPage(engine), as);
      expect({ result: outcome.result, derived: outcome.derived }).toEqual({ result: expect.stringMatching(UNREADABLE), derived: undefined });
      expect(databaseRefusal(outcome.error)).toMatchObject({ code: 'writer_coordinator_required',
        detail: { origin: 'database_guard', sqlstate: 'P0001', raiser: m.fn, branch: 'unreadable_state', relationship: 'unreadable_state' } });
    });
  }

  test('a policy for another role does not count as the caller\'s', async () => {
    const m = MAINTAINERS[0]!;
    await policies([m.hidden]);
    await engine.executeRaw(`CREATE POLICY ${SCOPED}_other ON ${m.hidden} FOR ALL TO ${BYPASS} USING (true) WITH CHECK (true)`);
    try {
      expect((await run(engine, m, await seedPage(engine), as)).result).toMatch(UNREADABLE);
    } finally {
      await engine.executeRaw(`DROP POLICY ${SCOPED}_other ON ${m.hidden}`);
    }
  });

  test('a role that bypasses RLS keeps the derived state with no policies at all', async () => {
    for (const table of tables) await engine.executeRaw(`DROP POLICY IF EXISTS ${SCOPED}_open ON ${table}`);
    for (const m of MAINTAINERS) expect(await run(engine, m, await seedPage(engine), { role: BYPASS }), m.fn).toEqual({ result: 'ok', derived: m.derived });
  });

  test('the docs/ENGINES.md maintainer recipe, applied verbatim, keeps the derived state for a scoped writer', async () => {
    await policies(MAINTAINER_TABLES);
    const recipe = docsRecipe(SCOPED);
    const created = [...recipe.matchAll(/CREATE POLICY (\w+) ON (\w+)/g)].map(match => ({ name: match[1]!, table: match[2]! }));
    expect([...new Set(created.map(p => p.table))].sort()).toEqual([...MAINTAINER_TABLES].sort());
    await engine.executeRaw(recipe);
    try {
      for (const m of MAINTAINERS) {
        expect(await run(engine, m, await seedPage(engine), { ...as, settings: { 'app.scopes': 'default' } }), m.fn).toEqual({ result: 'ok', derived: m.derived });
      }
    } finally {
      for (const p of created) await engine.executeRaw(`DROP POLICY IF EXISTS ${p.name} ON ${p.table}`);
    }
  });
});
