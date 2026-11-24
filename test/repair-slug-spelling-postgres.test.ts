/**
 * `gbrain repair slug-spelling` on Postgres: a write that is already under way against the page's stored spelling holds
 * that spelling's page lock, so the repair waits for it, and when that write changed the page the repair refuses
 * (`changed_since_preview`) instead of moving a page nobody approved.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: with a second connection holding the stored spelling's page lock and then editing the page, the repair
 *     started in between does not finish until that connection ends its transaction, then refuses `changed_since_preview`
 *     and leaves the page under its stored spelling.
 *  2. Regression: the repair locked the normal spelling twice and never the stored one, so such an edit could land after
 *     the repair's check and the page moved with the edit in it.
 *  3. Existing coverage: test/repair-slug-spelling.test.ts runs PGLite only (one connection, so it can only assert which
 *     locks were taken).
 *  4. Seam: none. Real Postgres, the repair command, and a second pool connection.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withStoredSlug } from '../src/core/utils.ts';
import { bareBody, delivered, HELD, holdFenceRow, ROWS } from './helpers/hold-page-id-fixture.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { encodedPostgres, isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const run = testBackends().includes('postgres') ? describe : describe.skip;
let engine: BrainEngine;
let close: () => Promise<void>;
let databaseUrl: string;
const home = mkdtempSync(join(tmpdir(), 'gbrain-slug-spelling-pg-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_INTERACTIVE: '0', CI: '1' };

beforeAll(async () => {
  if (!testBackends().includes('postgres')) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  engine = pg.engine; close = pg.close; databaseUrl = pg.databaseUrl;
}, 180_000);
afterAll(async () => {
  if (engine) await disposePersistenceConsumer(engine);
  await close?.();
  rmSync(home, { recursive: true, force: true });
}, 60_000);

async function repairJson(args: string[], on: BrainEngine = engine) {
  const { runRepairCommand } = await import('../src/commands/repair.ts');
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await runRepairCommand(on, [...args, '--json']); } finally { console.log = original; process.stdout.write = write; }
  return JSON.parse(printed).results[0] as { preview_hash: string; applied?: number };
}

run('postgres: the repair holds the stored spelling\'s page lock', () => {
  test('a write holding the stored spelling\'s lock makes the repair wait, and its edit refuses the move', () => withEnv(env, async () => {
    _resetCliExitVerdictForTests();
    const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const stored = 'Notes/Lock-Race';
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
    await engine.putPage('notes/seed-lock', { type: 'note', title: 'Lock race', compiled_truth: 'before', timeline: '' }, { sourceId });
    await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2 AND source_id=$3', [stored, 'notes/seed-lock', sourceId]);
    const preview = await repairJson(['slug-spelling', '--source', sourceId]);

    let release!: () => void, held!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = new Promise<void>(resolve => { held = resolve; });
    // An edit in flight: it holds the stored spelling's page lock (as every writer of an existing page does), then edits the page.
    const edit = maintenanceTransaction(engine, tx => withStoredSlug(stored, async () => {
      await tx.lockPageKeys([{ sourceId, slug: stored }]);
      held();
      await gate;
      await tx.executeRaw("UPDATE pages SET compiled_truth='edited while the repair waited' WHERE source_id=$1 AND slug=$2", [sourceId, stored]);
    }));
    await holding;

    let settled = false;
    const apply = repairJson(['slug-spelling', '--source', sourceId, '--apply', '--expect', preview.preview_hash, '--yes']).then(
      value => { settled = true; return value; }, error => { settled = true; throw error; });
    apply.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(settled).toBe(false);
    release();
    await edit;
    const error = await apply.then(() => undefined, e => e as OperationError);
    expect(error?.code).toBe('changed_since_preview');
    expect((await engine.executeRaw<{ slug: string; compiled_truth: string }>('SELECT slug, compiled_truth FROM pages WHERE source_id=$1', [sourceId])))
      .toEqual([{ slug: stored, compiled_truth: 'edited while the repair waited' }]);
  }), 60_000);

  test('the purge tombstones of the stored spelling follow the page on Postgres too', () => withEnv(env, async () => {
    _resetCliExitVerdictForTests();
    const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
    await engine.putPage('notes/seed-guards', { type: 'note', title: 'Guards', compiled_truth: 'before', timeline: '' }, { sourceId });
    await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2 AND source_id=$3', ['Notes/Guards-Move', 'notes/seed-guards', sourceId]);
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1', [sourceId]);
    await engine.executeRaw("INSERT INTO fact_purges(source_id, visibility, subject, fact_hash) VALUES ($1,'world','Notes/Guards-Move',gbrain_fact_fingerprint('A purged claim'))", [sourceId]);
    await engine.executeRaw("INSERT INTO take_purges(source_id, subject, claim_hash) VALUES ($1,'Notes/Guards-Move',gbrain_fact_fingerprint('A purged take'))", [sourceId]);
    const preview = await repairJson(['slug-spelling', '--source', sourceId]);
    await repairJson(['slug-spelling', '--source', sourceId, '--apply', '--expect', preview.preview_hash, '--yes']);
    const refused = (run: () => Promise<unknown>) => run().then(() => 'saved', e => (e as Error).message);
    expect(await refused(() => engine.insertFact({ fact: 'A purged claim', entity_slug: 'notes/guards-move', visibility: 'world', source: 'synthetic' }, { source_id: sourceId }))).toContain('purged_content');
    expect(await refused(() => engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: 'A purged take', kind: 'take', holder: 'brain', weight: 0.5 }]))).toContain('purged_content');
  }), 60_000);

  test('a hold a writer re-opens during the move, or records under the old spelling after it, still keeps its row out of the moved page', () => withEnv(env, async () => {
    _resetCliExitVerdictForTests();
    const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const later = 'Epsilon ships payroll next quarter';
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
    await engine.putPage('notes/seed-hold-race', { type: 'note', title: 'Hold race', compiled_truth: bareBody([...ROWS, [3, later]]), timeline: '' }, { sourceId });
    await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2 AND source_id=$3', ['Notes/Hold-Race', 'notes/seed-hold-race', sourceId]);
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1', [sourceId]);
    const hold = (tx: BrainEngine, claim = HELD, rowNum = 1) => holdFenceRow(tx, { sourceId, slug: 'Notes/Hold-Race', claim, rowNum });
    // The page's only hold is a decided record bound to the page, so nothing is omitted yet.
    await hold(engine);
    await engine.executeRaw("UPDATE write_gate_holds SET status='dropped' WHERE source_id=$1", [sourceId]);
    expect((await delivered(engine, sourceId, 'Notes/Hold-Race')).omit).toEqual([]);
    const preview = await repairJson(['slug-spelling', '--source', sourceId]);
    expect((preview as { listing?: Array<{ class: string }> }).listing?.map(l => l.class)).toEqual(['move']);

    let release!: () => void, resighted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const touched = new Promise<void>(resolve => { resighted = resolve; });
    // A writer that records no page lock: it re-opens the decided hold and keeps its transaction open while the move runs.
    const writer = engine.transaction(async tx => { await hold(tx); resighted(); await gate; });
    await touched;
    const apply = repairJson(['slug-spelling', '--source', sourceId, '--apply', '--expect', preview.preview_hash, '--yes']);
    apply.catch(() => undefined);
    await Promise.race([apply, new Promise(resolve => setTimeout(resolve, 1500))]);
    release();
    await writer;
    expect(await apply).toMatchObject({ applied: 1 });
    expect((await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [sourceId])).map(r => r.slug)).toEqual(['notes/hold-race']);
    // A writer on another connection that still names the old spelling after the move.
    await engine.transaction(async tx => { await hold(tx, later, 3); });
    const holds = await engine.executeRaw<{ status: string; page_id: number | null }>('SELECT status, page_id FROM write_gate_holds WHERE source_id=$1 ORDER BY id', [sourceId]);
    expect(holds.map(h => [h.status, h.page_id === null ? null : Number(h.page_id)])).toEqual([['held', Number(page!.id)], ['held', null]]);
    // What a reader delivers for the moved page: both held rows are left out, the never-held row is still there.
    const out = await delivered(engine, sourceId, 'notes/hold-race');
    expect(out.omit).toEqual([1, 3]);
    expect(out.text).toContain(ROWS[1]![1]);
    expect(out.text).not.toContain(HELD);
    expect(out.text).not.toContain(later);
  }), 60_000);

  test('on a database whose encoding is not UTF8, the upgrade completes without the spelling index and the repair refuses before reading anything', () => withEnv(env, async () => {
    _resetCliExitVerdictForTests();
    const db = await encodedPostgres(process.env.DATABASE_URL!, 'SQL_ASCII');
    try {
      await db.engine.initSchema();
      const [{ version }] = await db.engine.executeRaw<{ version: string }>("SELECT value AS version FROM config WHERE key='version'");
      const { LATEST_SCHEMA_VERSION } = await import('../src/core/schema-migrations/latest.generated.ts');
      const index = await db.engine.executeRaw("SELECT 1 FROM pg_indexes WHERE indexname='idx_pages_spelling_key'");
      await db.engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('enc','enc','{}')");
      await db.engine.putPage('notes/seed-enc', { type: 'note', title: 'Enc page', compiled_truth: 'x', timeline: '' }, { sourceId: 'enc' });
      await db.engine.executeRaw("UPDATE pages SET slug='Notes/Enc' WHERE slug='notes/seed-enc'");
      const error = await repairJson(['slug-spelling', '--source', 'enc'], db.engine).then(() => undefined, e => e as OperationError);
      const slugs = (await db.engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='enc'")).map(r => r.slug);
      expect({ version, index: index.length, code: error?.code, names: `${error?.message}`.includes('SQL_ASCII'), slugs })
        .toEqual({ version: String(LATEST_SCHEMA_VERSION), index: 0, code: 'slug_spelling_encoding', names: true, slugs: ['Notes/Enc'] });
    } finally { await disposePersistenceConsumer(db.engine); await db.close(); }
  }), 300_000);

  describe('a role that row-level security keeps from a guard table', () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const ROLE = `slug_repair_role_${suffix}`;
    let scoped: PostgresEngine;
    let database = '';
    beforeAll(async () => {
      database = new URL(databaseUrl).pathname.slice(1);
      await engine.executeRaw(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
      await engine.executeRaw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
      await engine.executeRaw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
      for (const table of ['fact_purges', 'take_purges', 'write_gate_holds']) await engine.executeRaw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      // Every connection of the database's login role now runs as the scoped role: not the owner, no RLS bypass.
      await engine.executeRaw(`DO $$ BEGIN EXECUTE format('ALTER ROLE %I IN DATABASE %I SET role TO %L', session_user, current_database(), '${ROLE}'); END $$`);
      scoped = new PostgresEngine();
      await scoped.connect({ database_url: databaseUrl, poolSize: 2 });
      const [who] = await scoped.executeRaw<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>('SELECT rolsuper, rolbypassrls, current_user FROM pg_roles WHERE rolname = current_user');
      expect(who).toEqual({ rolsuper: false, rolbypassrls: false, current_user: ROLE });
    }, 60_000);
    afterAll(async () => {
      await scoped?.disconnect();
      await engine.executeRaw(`DO $$ BEGIN EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET role', session_user, current_database()); END $$`).catch(() => undefined);
      await engine.executeRaw(`DROP OWNED BY ${ROLE}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    });

    /** Opens every row-level-security table to the role except `hidden` (the policy the docs recipe gives a writing role). */
    async function openAllBut(hidden: string | null) {
      const tables = await engine.executeRaw<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity ORDER BY 1");
      for (const { tablename } of tables) {
        await engine.executeRaw(`DROP POLICY IF EXISTS ${ROLE}_open ON ${tablename}`);
        if (tablename !== hidden) await engine.executeRaw(`CREATE POLICY ${ROLE}_open ON ${tablename} FOR ALL TO ${ROLE} USING (true) WITH CHECK (true)`);
      }
    }

    /** A page under an older spelling with a purged take, previewed as the owner; returns the apply argv. */
    async function purgedPage(sourceId: string, stored: string) {
      _resetCliExitVerdictForTests();
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
      await engine.putPage(`notes/seed-${sourceId}`, { type: 'note', title: 'Rls page', compiled_truth: 'before', timeline: '' }, { sourceId });
      await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2 AND source_id=$3', [stored, `notes/seed-${sourceId}`, sourceId]);
      await engine.executeRaw("INSERT INTO take_purges(source_id, subject, claim_hash) VALUES ($1,$2,gbrain_fact_fingerprint('A purged take'))", [sourceId, stored]);
      const preview = await repairJson(['slug-spelling', '--source', sourceId]);
      return ['slug-spelling', '--source', sourceId, '--apply', '--expect', preview.preview_hash, '--yes'];
    }
    /** Whether the purged take can be saved again on the page now at `slug` (as the owner). */
    async function takeComesBack(sourceId: string, slug: string): Promise<boolean> {
      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      if (!page) return false;
      return engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'A purged take', kind: 'take', holder: 'brain', weight: 0.5 }]).then(() => true, () => false);
    }
    const slugsIn = async (sourceId: string) => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [sourceId])).map(r => r.slug);

    test('a permissive policy that shows the role no tombstone (USING false) refuses the move, so the purged take cannot come back under the normal name', () => withEnv(env, async () => {
      const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const apply = await purgedPage(sourceId, 'Notes/Rls-Hide');
      await openAllBut('take_purges');
      await engine.executeRaw(`CREATE POLICY ${ROLE}_open ON take_purges FOR ALL TO ${ROLE} USING (false) WITH CHECK (true)`);
      try {
        const error = await repairJson(apply, scoped).then(() => undefined, e => e as OperationError);
        const text = `${error?.message} ${error?.suggestion}`;
        expect({ code: error?.code, names: text.includes('take_purges') && text.includes('BYPASSRLS'), slugs: await slugsIn(sourceId), comesBack: await takeComesBack(sourceId, 'notes/rls-hide') })
          .toEqual({ code: 'writer_coordinator_required', names: true, slugs: ['Notes/Rls-Hide'], comesBack: false });
      } finally {
        await openAllBut(null);
      }
    }), 120_000);

    test('an empty schema before public on the search path (the role-named schema of "$user") does not hide the brain tables from the check', () => withEnv(env, async () => {
      const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const apply = await purgedPage(sourceId, 'Notes/Rls-Schema');
      await openAllBut('take_purges');
      await engine.executeRaw(`CREATE POLICY ${ROLE}_open ON take_purges FOR ALL TO ${ROLE} USING (false) WITH CHECK (true)`);
      await engine.executeRaw(`CREATE SCHEMA ${ROLE} AUTHORIZATION ${ROLE}`);
      try {
        const [{ schema }] = await scoped.executeRaw<{ schema: string }>('SELECT current_schema() AS schema');
        const error = await repairJson(apply, scoped).then(() => undefined, e => e as OperationError);
        expect({ schema, code: error?.code, names: `${error?.message}`.includes('take_purges'), slugs: await slugsIn(sourceId), comesBack: await takeComesBack(sourceId, 'notes/rls-schema') })
          .toEqual({ schema: ROLE, code: 'writer_coordinator_required', names: true, slugs: ['Notes/Rls-Schema'], comesBack: false });
      } finally {
        await engine.executeRaw(`DROP SCHEMA IF EXISTS ${ROLE}`);
        await openAllBut(null);
      }
    }), 120_000);

    test('FORCE ROW LEVEL SECURITY on the owner refuses the move too, even with policies that show every row', () => withEnv(env, async () => {
      const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const apply = await purgedPage(sourceId, 'Notes/Rls-Force');
      await openAllBut(null);
      const [{ tableowner }] = await engine.executeRaw<{ tableowner: string }>("SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='fact_purges'");
      await engine.executeRaw(`ALTER TABLE fact_purges OWNER TO ${ROLE}`);
      await engine.executeRaw('ALTER TABLE fact_purges FORCE ROW LEVEL SECURITY');
      try {
        const error = await repairJson(apply, scoped).then(() => undefined, e => e as OperationError);
        expect({ code: error?.code, names: `${error?.message} ${error?.suggestion}`.includes('fact_purges'), slugs: await slugsIn(sourceId) })
          .toEqual({ code: 'writer_coordinator_required', names: true, slugs: ['Notes/Rls-Force'] });
      } finally {
        await engine.executeRaw('ALTER TABLE fact_purges NO FORCE ROW LEVEL SECURITY');
        await engine.executeRaw(`ALTER TABLE fact_purges OWNER TO "${tableowner}"`);
        // Handing ownership back drops the role's own grants on the table; give them back for the next cases.
        await engine.executeRaw(`GRANT ALL ON fact_purges TO ${ROLE}`);
      }
    }), 120_000);

    test('the doctor check never reports ok when row security hides pages from the role: the count is unknown', () => withEnv(env, async () => {
      const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
      await engine.putPage('notes/seed-doctor-hidden', { type: 'note', title: 'Hidden page', compiled_truth: 'x', timeline: '' }, { sourceId });
      await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2 AND source_id=$3', ['Notes/Doctor-Hidden', 'notes/seed-doctor-hidden', sourceId]);
      const [{ rowsecurity }] = await engine.executeRaw<{ rowsecurity: boolean }>("SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='pages'");
      await openAllBut('pages');
      if (!rowsecurity) await engine.executeRaw('ALTER TABLE pages ENABLE ROW LEVEL SECURITY');
      await engine.executeRaw(`CREATE POLICY ${ROLE}_open ON pages FOR SELECT TO ${ROLE} USING (false)`);
      try {
        const { legacySlugSpellingsEntry } = await import('../src/commands/doctor/checks/legacy-slug-spellings.ts');
        const [finding] = (await legacySlugSpellingsEntry.run({ engine: scoped } as never)) as unknown as Array<{ status: string; details?: Record<string, unknown>; message: string }>;
        expect({ status: finding?.status, count: finding?.details?.count, names: finding?.message.includes('row-level security') }).toEqual({ status: 'warn', count: 'unknown', names: true });
      } finally {
        await engine.executeRaw(`DROP POLICY IF EXISTS ${ROLE}_open ON pages`);
        if (!rowsecurity) await engine.executeRaw('ALTER TABLE pages DISABLE ROW LEVEL SECURITY');
        await openAllBut(null);
      }
    }), 120_000);

    // Every table the move reads or re-keys by slug (SLUG_COLUMNS_MOVED); the purge tables have their own cases below.
    for (const table of ['pages', 'files', 'facts', 'fact_withdrawals', 'page_aliases', 'secret_store_occurrence', 'slug_aliases', 'slug_rename_history']) {
      test(`row security on ${table} (a policy that shows the role nothing) refuses the preview and names the table`, () => withEnv(env, async () => {
        const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        await purgedPage(sourceId, `Notes/Rls-${table}`);
        const [{ rowsecurity }] = await engine.executeRaw<{ rowsecurity: boolean }>("SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename=$1", [table]);
        if (!rowsecurity) await engine.executeRaw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        await openAllBut(table);
        await engine.executeRaw(`CREATE POLICY ${ROLE}_open ON ${table} FOR ALL TO ${ROLE} USING (false) WITH CHECK (true)`);
        try {
          const error = await repairJson(['slug-spelling', '--source', sourceId], scoped).then(() => undefined, e => e as OperationError);
          expect({ code: error?.code, names: `${error?.message}`.includes(table) && `${error?.suggestion}`.includes('BYPASSRLS'), slugs: await slugsIn(sourceId) })
            .toEqual({ code: 'writer_coordinator_required', names: true, slugs: [`Notes/Rls-${table}`] });
        } finally {
          await engine.executeRaw(`DROP POLICY IF EXISTS ${ROLE}_open ON ${table}`);
          if (!rowsecurity) await engine.executeRaw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
          await openAllBut(null);
        }
      }), 120_000);
    }

    test('a source row security hides from the role is refused before the repair runs (the source must exist), and nothing moves', () => withEnv(env, async () => {
      const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await purgedPage(sourceId, 'Notes/Rls-Source');
      await openAllBut('sources');
      await engine.executeRaw(`CREATE POLICY ${ROLE}_open ON sources FOR ALL TO ${ROLE} USING (false) WITH CHECK (true)`);
      try {
        const error = await repairJson(['slug-spelling', '--source', sourceId], scoped).then(() => undefined, e => e as OperationError);
        expect({ code: error?.code, slugs: await slugsIn(sourceId) }).toEqual({ code: 'invalid_params', slugs: ['Notes/Rls-Source'] });
      } finally {
        await openAllBut(null);
      }
    }), 120_000);

    for (const hidden of ['take_purges', 'fact_purges']) {
      test(`${hidden} hidden from the role: the move is refused before anything moves, also once the role has policies, and the owner moves it`, () => withEnv(env, async () => {
        _resetCliExitVerdictForTests();
        const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
        await engine.putPage('notes/seed-rls', { type: 'note', title: 'Rls page', compiled_truth: 'before', timeline: '' }, { sourceId });
        await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2 AND source_id=$3', ['Notes/Rls-Move', 'notes/seed-rls', sourceId]);
        await engine.executeRaw("INSERT INTO take_purges(source_id, subject, claim_hash) VALUES ($1,'Notes/Rls-Move',gbrain_fact_fingerprint('A purged take'))", [sourceId]);
        const preview = await repairJson(['slug-spelling', '--source', sourceId]);
        const apply = ['slug-spelling', '--source', sourceId, '--apply', '--expect', preview.preview_hash, '--yes'];
        await openAllBut(hidden);
        const error = await repairJson(apply, scoped).then(() => undefined, e => e as OperationError);
        expect({ code: error?.code, text: `${error?.message} ${error?.suggestion}`.includes(hidden) }).toEqual({ code: 'writer_coordinator_required', text: true });
        expect((await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [sourceId])).map(r => r.slug)).toEqual(['Notes/Rls-Move']);
        // Policies of the role on every table still do not prove it sees every tombstone: refused again; the owner moves it.
        await openAllBut(null);
        expect((await repairJson(apply, scoped).then(() => undefined, e => e as OperationError))?.code).toBe('writer_coordinator_required');
        await repairJson(apply);
        expect((await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [sourceId])).map(r => r.slug)).toEqual(['notes/rls-move']);
        expect((await engine.executeRaw('SELECT 1 FROM take_purges WHERE source_id=$1 AND subject=$2', [sourceId, 'notes/rls-move'])).length).toBe(1);
      }), 120_000);
    }
  });
});
