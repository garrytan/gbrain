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
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
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

  test('the purge tombstones and held writes of the stored spelling follow the page on Postgres too', () => withEnv(env, async () => {
    _resetCliExitVerdictForTests();
    const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
    await engine.putPage('notes/seed-guards', { type: 'note', title: 'Guards', compiled_truth: 'before', timeline: '' }, { sourceId });
    await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2 AND source_id=$3', ['Notes/Guards-Move', 'notes/seed-guards', sourceId]);
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1', [sourceId]);
    await engine.executeRaw("INSERT INTO fact_purges(source_id, visibility, subject, fact_hash) VALUES ($1,'world','Notes/Guards-Move',gbrain_fact_fingerprint('A purged claim'))", [sourceId]);
    await engine.executeRaw("INSERT INTO take_purges(source_id, subject, claim_hash) VALUES ($1,'Notes/Guards-Move',gbrain_fact_fingerprint('A purged take'))", [sourceId]);
    await engine.executeRaw(`INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload)
      VALUES ('fact', $1, 'Notes/Guards-Move', 'fp-guards', 2, 'external_untrusted', $2::text::jsonb)`, [sourceId, JSON.stringify({ fact: 'x', entity_slug: 'Notes/Guards-Move', row_num: 1 })]);
    const preview = await repairJson(['slug-spelling', '--source', sourceId]);
    await repairJson(['slug-spelling', '--source', sourceId, '--apply', '--expect', preview.preview_hash, '--yes']);
    const refused = (run: () => Promise<unknown>) => run().then(() => 'saved', e => (e as Error).message);
    expect(await refused(() => engine.insertFact({ fact: 'A purged claim', entity_slug: 'notes/guards-move', visibility: 'world', source: 'synthetic' }, { source_id: sourceId }))).toContain('purged_content');
    expect(await refused(() => engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: 'A purged take', kind: 'take', holder: 'brain', weight: 0.5 }]))).toContain('purged_content');
    const [hold] = await engine.executeRaw<{ slug: string; status: string; payload: { entity_slug: string } | string }>('SELECT slug, status, payload FROM write_gate_holds WHERE source_id=$1', [sourceId]);
    expect({ slug: hold!.slug, status: hold!.status, entity: (typeof hold!.payload === 'string' ? JSON.parse(hold!.payload) : hold!.payload).entity_slug }).toEqual({ slug: 'notes/guards-move', status: 'held', entity: 'notes/guards-move' });
  }), 60_000);

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

    for (const hidden of ['take_purges', 'fact_purges', 'write_gate_holds']) {
      test(`${hidden} hidden from the role: the move is refused before anything moves, and moves once the role can read it`, () => withEnv(env, async () => {
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
        await openAllBut(null);
        await repairJson(apply, scoped);
        expect((await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [sourceId])).map(r => r.slug)).toEqual(['notes/rls-move']);
        expect((await engine.executeRaw('SELECT 1 FROM take_purges WHERE source_id=$1 AND subject=$2', [sourceId, 'notes/rls-move'])).length).toBe(1);
      }), 120_000);
    }
  });
});
