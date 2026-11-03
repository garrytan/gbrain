/**
 * #7636: the writer-protocol fences read singleton state (persistence_brain, git_canonical_brain) and the sources,
 * pages and persistence tables as the writing role. A role that neither owns those tables nor bypasses RLS, with
 * write policies on the guarded table but none on the lookup, read zero rows, and the fence took that as "unmanaged",
 * "G7a off", "floor unknown" or "quiesced" and let the write through.
 *
 * Contract: such a lookup raises writer_coordinator_required (unreadable state). The owner, an unmanaged brain and a
 * role that can read the state behave exactly as before, including the cascade a coordinated page delete runs. The
 * exceptions are protocol activation and the git-canonical source recount: they refuse any caller row-level security
 * filters, whatever its policies, because a hidden row cannot be told from an absent one there.
 * The owner arm runs on PGLite and Postgres (PGLite has no roles: its behaviour is unchanged); the scoped-role arm
 * runs on Postgres through test/e2e/writer-fence-fail-closed-7636-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-7636-db-'));
let closePostgres: (() => Promise<void>) | undefined;
const ROLE = 'gbrain_fence_7636_' + randomUUID().replaceAll('-', '').slice(0, 12);
const LOOKUPS = ['persistence_brain', 'git_canonical_brain', 'sources', 'pages', 'persistence_requests', 'persistence_effects',
  'persistence_worktrees', 'persistence_source_bindings'];
const UNREADABLE = /writer_coordinator_required: writer state is unreadable to this database role/;
const ALLOWLIST = /writer_coordinator_required: canonical writer must use the persistence coordinator/;
const GIT_PROTOCOL = /git_protocol_required/;
const NOT_QUIESCED = /writer_not_quiesced/;
const UPGRADE = /writer_upgrade_required/;
const ROLLBACK = 'fence-probe-rollback';
/** No persistence protocol declared (PGLite's engine declares protocol 2 for its own session). */
const NO_PROTOCOL = { 'gbrain.persistence_protocol': '' };

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
  for (const { engine } of engines) await seed(engine);
}, 180_000);
afterAll(async () => {
  for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

/** Replaces the singleton (the activation trigger forbids lowering the floor by UPDATE), keeping its other columns. */
async function singleton(engine: BrainEngine, enabled: boolean, floor: 1 | 2) {
  await engine.executeRaw(`WITH old AS (DELETE FROM persistence_brain WHERE singleton = 1 RETURNING *)
    INSERT INTO persistence_brain SELECT (jsonb_populate_record(NULL::persistence_brain, to_jsonb(old)
      || jsonb_build_object('enabled', $1::boolean, 'writer_protocol_floor', $2::int, 'skill_bundles_enabled', false))).* FROM old`, [enabled, floor]);
}

const seeded = new Map<BrainEngine, { pageId: number; requestId: string; effectId: number }>();
/** One page with a tag in 'default', a git-canonical source (strict_sources = 1), a queued request and its effect. */
async function seed(engine: BrainEngine) {
  await singleton(engine, false, 1);
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('git-src','git-src','{"canonical":"git"}') ON CONFLICT (id) DO NOTHING`);
  const [page] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES('default','notes/fence-seed','note','Seed','body') RETURNING id`);
  await engine.executeRaw(`INSERT INTO tags(page_id,tag,tag_source) VALUES($1,'seed','added')`, [page!.id]);
  const [request] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,
      source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation)
    SELECT 'application','fence-test',gen_random_uuid(),'put_page','default',incarnation,'notes/fence-seed','digest','{}'::jsonb,0,0
    FROM sources WHERE id='default' RETURNING id::text AS id`);
  const [effect] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO persistence_effects(request_id,kind,data) VALUES($1::uuid,'embedding','{}'::jsonb) RETURNING id::int AS id`, [request!.id]);
  seeded.set(engine, { pageId: page!.id, requestId: request!.id, effectId: effect!.id });
}

/** Runs `sql` in a transaction that always rolls back: 'ok' or the error message. `role` switches to the scoped role. */
async function attempt(engine: BrainEngine, sql: string, params: unknown[] = [],
  opts: { role?: string; settings?: Record<string, string> } = {}): Promise<string> {
  try {
    await engine.transaction(async tx => {
      if (opts.role) await tx.executeRaw(`SET LOCAL ROLE ${opts.role}`);
      for (const [key, value] of Object.entries(opts.settings ?? {})) await tx.executeRaw(`SELECT set_config($1,$2,true)`, [key, value]);
      await tx.executeRaw(sql, params);
      throw new Error(ROLLBACK);
    });
    return 'unreachable';
  } catch (error) {
    const message = (error as Error).message;
    return message === ROLLBACK ? 'ok' : message;
  }
}

const newPage = (source: string) => [`INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,$2,'note','Probe','body')`,
  [source, `notes/probe-${randomUUID().slice(0, 8)}`]] as [string, unknown[]];
const coordinator = (sources: string[]) => ({ 'gbrain.write_sources': JSON.stringify(sources) });
const QUIESCED = { 'gbrain.persistence_protocol': '2', 'gbrain.writer_quiesced': 'true' };
const ACTIVATE = 'UPDATE persistence_brain SET writer_protocol_floor=2 WHERE singleton=1';

describe('owner behaviour is unchanged', () => {
  test('an unmanaged brain takes writes without a coordinator; a managed one refuses them as before', async () => {
    for (const { name, engine } of engines) {
      const { pageId } = seeded.get(engine)!;
      await singleton(engine, false, 1);
      expect(await attempt(engine, ...newPage('default')), name).toBe('ok');
      expect(await attempt(engine, 'DELETE FROM tags WHERE page_id=$1', [pageId]), name).toBe('ok');
      await singleton(engine, true, 1);
      expect(await attempt(engine, ...newPage('default')), name).toMatch(ALLOWLIST);
      expect(await attempt(engine, 'DELETE FROM tags WHERE page_id=$1', [pageId]), name).toMatch(ALLOWLIST);
      expect(await attempt(engine, ...newPage('default'), { settings: coordinator(['default']) }), name).toBe('ok');
      expect(await attempt(engine, 'DELETE FROM pages WHERE id=$1', [pageId], { settings: coordinator(['default']) }), name).toBe('ok');
      expect(await attempt(engine, ...newPage('git-src'), { settings: coordinator(['git-src']) }), name).toMatch(GIT_PROTOCOL);
      expect(await attempt(engine, ...newPage('git-src'), { settings: { ...coordinator(['git-src']), 'gbrain.git_protocol': '1' } }), name).toBe('ok');
    }
  });

  test('the protocol floor, activation and the git-canonical count behave as before', async () => {
    for (const { name, engine } of engines) {
      const { requestId, effectId } = seeded.get(engine)!;
      await singleton(engine, true, 1);
      expect(await attempt(engine, ACTIVATE, [], { settings: QUIESCED }), name).toMatch(NOT_QUIESCED);
      await singleton(engine, true, 2);
      expect(await attempt(engine, 'UPDATE persistence_effects SET updated_at=now() WHERE id=$1', [effectId], { settings: NO_PROTOCOL }), name).toMatch(UPGRADE);
      expect(await attempt(engine, 'UPDATE persistence_requests SET updated_at=now() WHERE id=$1::uuid', [requestId], { settings: NO_PROTOCOL }), name).toMatch(UPGRADE);
      expect(await attempt(engine, 'UPDATE persistence_effects SET updated_at=now() WHERE id=$1', [effectId], { settings: { 'gbrain.persistence_protocol': '2' } }), name).toBe('ok');
      await singleton(engine, false, 1);
      expect(await engine.executeRaw('SELECT strict_sources FROM git_canonical_brain'), name).toEqual([{ strict_sources: 1 }]);
      await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('git-two','git-two','{"canonical":"git"}')`);
      expect(await engine.executeRaw('SELECT strict_sources FROM git_canonical_brain'), name).toEqual([{ strict_sources: 2 }]);
      await engine.executeRaw(`DELETE FROM sources WHERE id='git-two'`);
      expect(await engine.executeRaw('SELECT strict_sources FROM git_canonical_brain'), name).toEqual([{ strict_sources: 1 }]);
    }
  });

  // gstack /ship Step 7 coverage audit (pass 1).
  // Value: protects=a missing persistence_brain singleton is refused as unreadable_state (never "unmanaged") and classified
  //   as writer_coordinator_required with its own text; fails_when=the NOT FOUND raise reverts to a pass, or its CONSTRAINT or
  //   DETAIL stop matching publication-failure.ts; why_new=that branch ran only under a Postgres scoped role, and no test fed a
  //   real unreadable_state raise through databaseRefusal; seam=none; no_claim=how the consumer stores it on a receipt
  //   (databaseRefusal called directly on the driver error)
  test('a missing persistence_brain singleton is refused, not read as unmanaged, and classified as unreadable state', async () => {
    for (const { name, engine } of engines) {
      await singleton(engine, false, 1);
      let caught: unknown;
      try {
        await engine.transaction(async tx => {
          await tx.executeRaw('DELETE FROM persistence_brain WHERE singleton = 1');
          await tx.executeRaw(...newPage('default'));
          throw new Error(ROLLBACK);
        });
      } catch (error) { caught = error; }
      expect((caught as Error).message, name).toMatch(UNREADABLE);
      const refusal = databaseRefusal(caught);
      expect(refusal, name).toMatchObject({ code: 'writer_coordinator_required',
        detail: { origin: 'database_guard', sqlstate: 'P0001', table: 'pages', op: 'INSERT', branch: 'unreadable_state', relationship: 'unreadable_state' } });
      expect(refusal!.message, name).toContain('row-level security hides it');
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_brain'), name).toEqual([{ n: 1 }]);
    }
  });
});

(backends.includes('postgres') ? describe : describe.skip)('a scoped role that cannot read the fence state (Postgres)', () => {
  let engine: BrainEngine;
  let pageId = 0, requestId = '', effectId = 0;
  const as = { role: ROLE };
  let tables: string[] = [];
  /** Open policies for the role on every table except `hidden`; `scoped` replaces one table's policy. */
  async function policies(hidden: string[], scoped: Record<string, string> = {}) {
    for (const table of tables) {
      await engine.executeRaw(`DROP POLICY IF EXISTS ${ROLE}_open ON ${table}`);
      if (hidden.includes(table)) continue;
      await engine.executeRaw(`CREATE POLICY ${ROLE}_open ON ${table} FOR ALL TO ${ROLE} USING (${scoped[table] ?? 'true'}) WITH CHECK (true)`);
    }
  }

  beforeAll(async () => {
    engine = engines.find(e => e.name === 'postgres')!.engine;
    ({ pageId, requestId, effectId } = seeded.get(engine)!);
    await engine.executeRaw(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await engine.executeRaw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
    await engine.executeRaw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
    for (const table of LOOKUPS) await engine.executeRaw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    tables = (await engine.executeRaw<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map(r => r.t);
    const [effective] = await engine.transaction(async tx => {
      await tx.executeRaw(`SET LOCAL ROLE ${ROLE}`);
      return tx.executeRaw<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    });
    expect(effective).toEqual({ rolsuper: false, rolbypassrls: false });
  }, 60_000);
  afterAll(async () => {
    if (!engine) return;
    for (const table of tables) await engine.executeRaw(`DROP POLICY IF EXISTS ${ROLE}_open ON ${table}`);
    await engine.executeRaw(`DROP OWNED BY ${ROLE}`).catch(() => undefined);
    await engine.executeRaw(`DROP ROLE IF EXISTS ${ROLE}`);
  });

  test('a role that can read the state passes and is refused exactly as the owner is', async () => {
    await policies([]);
    await singleton(engine, false, 1);
    expect(await attempt(engine, ...newPage('default'), as)).toBe('ok');
    await singleton(engine, true, 1);
    expect(await attempt(engine, ...newPage('default'), as)).toMatch(ALLOWLIST);
    expect(await attempt(engine, ...newPage('default'), { ...as, settings: coordinator(['default']) })).toBe('ok');
    expect(await attempt(engine, 'DELETE FROM tags WHERE page_id=$1', [pageId], as)).toMatch(ALLOWLIST);
    // The cascade to tags runs as their owner, so a deleted parent page still reads as a cascade, not as hidden state.
    expect(await attempt(engine, 'DELETE FROM pages WHERE id=$1', [pageId], { ...as, settings: coordinator(['default']) })).toBe('ok');
    expect(await attempt(engine, ...newPage('git-src'), { ...as, settings: coordinator(['git-src']) })).toMatch(GIT_PROTOCOL);
    expect(await attempt(engine, ...newPage('git-src'), { ...as, settings: { ...coordinator(['git-src']), 'gbrain.git_protocol': '1' } })).toBe('ok');
    await singleton(engine, true, 2);
    expect(await attempt(engine, 'UPDATE persistence_effects SET updated_at=now() WHERE id=$1', [effectId], { ...as, settings: NO_PROTOCOL })).toMatch(UPGRADE);
    expect(await attempt(engine, 'UPDATE persistence_requests SET updated_at=now() WHERE id=$1::uuid', [requestId], { ...as, settings: NO_PROTOCOL })).toMatch(UPGRADE);
  });

  test('gbrain_require_managed_writer: a hidden persistence_brain no longer reads as an unmanaged brain', async () => {
    await policies(['persistence_brain']);
    await singleton(engine, true, 1);
    expect(await attempt(engine, ...newPage('default'), as)).toMatch(UNREADABLE);
    expect(await attempt(engine, ...newPage('default'), { ...as, settings: coordinator(['default']) })).toMatch(UNREADABLE);
  });

  test('gbrain_require_managed_writer: a hidden git_canonical_brain no longer switches the G7a fence off', async () => {
    await policies(['git_canonical_brain']);
    await singleton(engine, true, 1);
    expect(await attempt(engine, ...newPage('git-src'), { ...as, settings: coordinator(['git-src']) })).toMatch(UNREADABLE);
    expect(await attempt(engine, ...newPage('git-src'), { ...as, settings: { ...coordinator(['git-src']), 'gbrain.git_protocol': '1' } })).toBe('ok');
  });

  test('gbrain_require_managed_writer: a hidden git-canonical source no longer passes the G7a fence', async () => {
    await policies(['sources']);
    await singleton(engine, true, 1);
    expect(await attempt(engine, ...newPage('git-src'), { ...as, settings: coordinator(['git-src']) })).toMatch(UNREADABLE);
  });

  test('gbrain_require_managed_writer: a page child whose page is hidden no longer reads as a cascaded delete', async () => {
    await policies(['pages']);
    await singleton(engine, true, 1);
    expect(await attempt(engine, 'DELETE FROM tags WHERE page_id=$1', [pageId], as)).toMatch(UNREADABLE);
  });

  // gstack /ship Step 7 coverage audit (pass 1).
  // Value: protects=a page child moved off a page RLS hides is refused (the old-page lookup of an UPDATE); fails_when=the
  //   NOT FOUND check after the old_source lookup is dropped, so old_source stays NULL and the allowlist passes; why_new=only
  //   a DELETE (new-page lookup) was covered; seam=none; no_claim=timeline_entries and takes (same branch, tags stand in)
  test('gbrain_require_managed_writer: moving a page child off a page row-level security hides is refused', async () => {
    await singleton(engine, false, 1);
    const [target] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
      VALUES('default',$1,'note','Target','body') RETURNING id`, [`notes/target-${randomUUID().slice(0, 8)}`]);
    try {
      await singleton(engine, true, 1);
      const move = ['UPDATE tags SET page_id=$1 WHERE page_id=$2', [target!.id, pageId]] as [string, unknown[]];
      await policies([]);
      expect(await attempt(engine, ...move, { ...as, settings: coordinator(['default']) })).toBe('ok');
      await policies([], { pages: `id <> ${Number(pageId)}` });
      expect(await attempt(engine, ...move, { ...as, settings: coordinator(['default']) })).toMatch(UNREADABLE);
    } finally {
      await singleton(engine, false, 1);
      await engine.executeRaw('DELETE FROM pages WHERE id=$1', [target!.id]);
    }
  });

  // gstack /ship Step 7 coverage audit (pass 1).
  // Value: protects=G7a counts both sources of a cross-source move, so a hidden git-canonical old source is refused;
  //   fails_when=the expected count CASE collapses to 1, letting a page leave a hidden git-canonical source without the git
  //   protocol; why_new=only single-source INSERTs were covered; seam=none; no_claim=the reverse move (same comparison)
  test('gbrain_require_managed_writer: moving a page out of a git-canonical source row-level security hides is refused', async () => {
    await singleton(engine, false, 1);
    const [moved] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
      VALUES('git-src',$1,'note','Moved','body') RETURNING id`, [`notes/moved-${randomUUID().slice(0, 8)}`]);
    try {
      await singleton(engine, true, 1);
      const move = ['UPDATE pages SET source_id=$1 WHERE id=$2', ['default', moved!.id]] as [string, unknown[]];
      const settings = coordinator(['default', 'git-src']);
      await policies([]);
      expect(await attempt(engine, ...move, { ...as, settings })).toMatch(GIT_PROTOCOL);
      await policies([], { sources: `id <> 'git-src'` });
      expect(await attempt(engine, ...move, { ...as, settings })).toMatch(UNREADABLE);
    } finally {
      await singleton(engine, false, 1);
      await engine.executeRaw('DELETE FROM pages WHERE id=$1', [moved!.id]);
    }
  });

  test('gbrain_guard_effect_protocol and gbrain_guard_request_protocol: a hidden floor no longer reads as no floor', async () => {
    await policies(['persistence_brain']);
    await singleton(engine, true, 2);
    expect(await attempt(engine, 'UPDATE persistence_effects SET updated_at=now() WHERE id=$1', [effectId], { ...as, settings: NO_PROTOCOL })).toMatch(UNREADABLE);
    expect(await attempt(engine, 'UPDATE persistence_requests SET updated_at=now() WHERE id=$1::uuid', [requestId], { ...as, settings: NO_PROTOCOL })).toMatch(UNREADABLE);
  });

  test('gbrain_guard_protocol_activation: hidden pending requests no longer read as quiesced', async () => {
    await policies(['persistence_requests']);
    await singleton(engine, true, 1);
    expect(await attempt(engine, ACTIVATE, [], { ...as, settings: QUIESCED })).toMatch(UNREADABLE);
  });

  // gstack /ship Step 7 coverage audit (pass 1).
  // Value: protects=row-level security on any one of the five tables activation must see empty refuses it; fails_when=a
  //   table drops out of the row_security_active list, so activation reads that table filtered; why_new=RLS was on all five
  //   at once, so only the first operand was exercised; seam=none; no_claim=a policy that filters rows (RLS on, open policy)
  test('gbrain_guard_protocol_activation: row-level security on any one table it must see empty refuses activation', async () => {
    const watched = ['persistence_requests', 'persistence_effects', 'persistence_worktrees', 'persistence_source_bindings', 'sources'];
    await policies([]);
    await singleton(engine, true, 1);
    try {
      for (const table of watched) await engine.executeRaw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      // Every table readable: the seeded queued request blocks activation as it does for the owner.
      expect(await attempt(engine, ACTIVATE, [], { ...as, settings: QUIESCED })).toMatch(NOT_QUIESCED);
      for (const hidden of watched) {
        for (const table of watched) await engine.executeRaw(`ALTER TABLE ${table} ${table === hidden ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`);
        expect(await attempt(engine, ACTIVATE, [], { ...as, settings: QUIESCED }), hidden).toMatch(UNREADABLE);
      }
    } finally {
      for (const table of watched) await engine.executeRaw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
  });

  test('gbrain_count_git_canonical_sources: a recount over the sources RLS lets the role see is refused', async () => {
    await policies([], { sources: `id = 'scoped-src'` });
    await singleton(engine, false, 1);
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('scoped-src','scoped-src','{"canonical":"git"}')`);
    try {
      expect(await engine.executeRaw('SELECT strict_sources FROM git_canonical_brain')).toEqual([{ strict_sources: 2 }]);
      // Recounting only 'scoped-src' would store 0 while 'git-src' is still git-canonical, switching G7a off.
      expect(await attempt(engine, `UPDATE sources SET config='{}'::jsonb WHERE id='scoped-src'`, [], as)).toMatch(UNREADABLE);
      expect(await engine.executeRaw('SELECT strict_sources FROM git_canonical_brain')).toEqual([{ strict_sources: 2 }]);
    } finally {
      await engine.executeRaw(`DELETE FROM sources WHERE id='scoped-src'`);
    }
  });
});
