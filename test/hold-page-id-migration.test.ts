/**
 * Migration v333: quarantine holds remember their page (plan decisions C, F, K; companion of test/hold-page-id.test.ts).
 *
 * Authoring gate
 *  1. Protects: the upgrade ties each existing hold to its page by classification, never by guess: exact, lineage and
 *     payload-id bind; a reused name or several candidates stay unbound but are held for every candidate; a purged or
 *     never-a-page hold stays unbound. Twins the page's several names produced merge only when identical, and a twin
 *     that differs is never dropped. A brain whose table predates the columns upgrades through the schema replay
 *     (forward-reference bootstrap, then the blob), and a retried migration changes nothing.
 *  2. Fails when: the backfill matches by slug alone, merges or drops a hold that differs, or the replay on a
 *     pre-column brain stops at the blob's new indexes.
 *  3. Why new: test/schema-bootstrap-coverage.test.ts pins that the bootstrap adds the columns, and the catalog goldens
 *     pin the end state; neither runs the classification over rows.
 *  4. Seams: the real migration (`runMigrations` over the registry) and the real `initSchema` replay, on PGLite and,
 *     when DATABASE_URL is set, on Postgres (testBackends). Holds are inserted as a pre-v333 writer would have (no page
 *     columns, which the test removes first); pages and renames go through the engine.
 */
import { withEnv } from './helpers/with-env.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { bareBody, expectHeldHidden, HELD, holdFenceRow, ROWS } from './helpers/hold-page-id-fixture.ts';

const OLD_INDEX = 'CREATE UNIQUE INDEX write_gate_holds_dedupe_idx ON write_gate_holds (source_id, slug, fingerprint, detector_version)';

/** Takes the brain back to its v332 shape: no binding columns (their indexes go with them), the old dedupe index, version 332. */
async function toV332(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('ALTER TABLE write_gate_holds DROP COLUMN IF EXISTS page_id');
  await engine.executeRaw('ALTER TABLE write_gate_holds DROP COLUMN IF EXISTS page_candidates');
  await engine.executeRaw('DROP INDEX IF EXISTS write_gate_holds_dedupe_idx');
  await engine.executeRaw(OLD_INDEX);
  await engine.setConfig('version', '332');
}

interface HoldState { id: number; slug: string; page_id: number | null; page_candidates: number[] | null; status: string; seen_count: number }
const holdStates = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ id: string; slug: string; page_id: string | null; page_candidates: string[] | null; status: string; seen_count: number }>(
  'SELECT id::text AS id, slug, page_id::text AS page_id, page_candidates::text[] AS page_candidates, status, seen_count FROM write_gate_holds WHERE source_id=$1 ORDER BY id', [sourceId]))
  .map((h): HoldState => ({ id: Number(h.id), slug: h.slug, page_id: h.page_id === null ? null : Number(h.page_id), page_candidates: h.page_candidates?.map(Number) ?? null, status: h.status, seen_count: Number(h.seen_count) }));

const backends = testBackends();
const brains: Array<{ backend: string; engine: BrainEngine; close: () => Promise<void> }> = [];

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    brains.push({ backend: 'pglite', engine, close: () => engine.disconnect() });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
    brains.push({ backend: 'postgres', engine: pg.engine, close: pg.close });
  }
}, 180_000);
afterAll(async () => { for (const b of brains) await b.close(); });

for (const backend of backends) {
  describe(`v333 hold_page_id backfill (${backend})`, () => {
    const brain = () => brains.find(b => b.backend === backend)!.engine;

    // Pins decision C: one brain holding every class of hold, classified by the real migration.
    test('classifies every hold: exact, lineage and payload-id bind; reused names and several candidates are contained; purged and never-a-page stay unbound', async () => {
      const engine = brain();
      const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
      const page = async (slug: string, ageDays: number) => {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}`, timeline: '' }, { sourceId });
        await engine.executeRaw("UPDATE pages SET created_at = now() - make_interval(days => $3) WHERE source_id=$1 AND slug=$2", [sourceId, slug, ageDays]);
        return Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.id);
      };
      const rename = async (from: string, to: string) => { expect(await engine.updateSlug(from, to, { sourceId })).toBe(1); };

      const exact = await page('notes/exact', 10);
      await page('notes/lin-old', 10); await rename('notes/lin-old', 'notes/lin-new');
      const lin = Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id=$1 AND slug='notes/lin-new'", [sourceId]))[0]!.id);
      const target = await page('notes/payload-target', 10);
      await page('notes/reused', 1);
      await page('notes/mv-old', 10); await rename('notes/mv-old', 'notes/mv-new');
      const mvNew = Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id=$1 AND slug='notes/mv-new'", [sourceId]))[0]!.id);
      const mvOld = await page('notes/mv-old', 10);
      const reused = Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id=$1 AND slug='notes/reused'", [sourceId]))[0]!.id);
      await page('notes/tw-old', 10); await rename('notes/tw-old', 'notes/tw-new');
      const tw = Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id=$1 AND slug='notes/tw-new'", [sourceId]))[0]!.id);
      await page('notes/td-old', 10); await rename('notes/td-old', 'notes/td-new');
      const td = Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id=$1 AND slug='notes/td-new'", [sourceId]))[0]!.id);

      await toV332(engine);
      const add = async (slug: string, fp: string, o: { payload?: Record<string, unknown>; seen?: number; status?: string; kind?: string } = {}) => {
        const [row] = await engine.executeRaw<{ id: string }>(
          `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload, status, seen_count, created_at, last_seen_at)
           VALUES ($7, $1, $2, $3, 2, 'external_untrusted', $4::text::jsonb, $5, $6, now() - interval '5 days', now() - interval '5 days') RETURNING id::text AS id`,
          [sourceId, slug, fp, JSON.stringify(o.payload ?? { fact: fp }), o.status ?? 'held', o.seen ?? 1, o.kind ?? 'fact']);
        const id = Number(row!.id);
        await engine.executeRaw(`INSERT INTO write_gate_receipts (target_table, target_id, source_id, content_hash, tier, detector_version, verdict)
          VALUES ('write_gate_holds', $1, $2, $3, 'external_untrusted', 2, 'quarantine')`, [String(id), sourceId, `hash-${fp}-${id}`]);
        return id;
      };
      const h = {
        exact: await add('notes/exact', 'fp-exact'),
        lineage: await add('notes/lin-old', 'fp-lineage'),
        payload: await add('notes/payload-gone', 'fp-payload', { kind: 'take', payload: { page_id: target, claim: 'a claim' } }),
        reused: await add('notes/reused', 'fp-reused'),
        movedAndReused: await add('notes/mv-old', 'fp-moved'),
        never: await add('notes/never', 'fp-never'),
        purged: await add('notes/purged-gone', 'fp-purged', { kind: 'take', payload: { page_id: 987654321, claim: 'gone' } }),
        blank: await add('', 'fp-blank'),
        twinOld: await add('notes/tw-old', 'fp-twin', { payload: { fact: 'same' }, seen: 2 }),
        twinNew: await add('notes/tw-new', 'fp-twin', { payload: { fact: 'same' }, seen: 3 }),
        diffOld: await add('notes/td-old', 'fp-differs', { payload: { fact: 'one' } }),
        diffNew: await add('notes/td-new', 'fp-differs', { payload: { fact: 'two' } }),
      };

      await runMigrations(engine);
      const by = new Map((await holdStates(engine, sourceId)).map(s => [s.id, s]));
      const bound = (id: number) => by.has(id) ? [by.get(id)!.page_id, by.get(id)!.page_candidates] : ['absent'];
      expect(bound(h.exact)).toEqual([exact, null]);
      expect(bound(h.lineage)).toEqual([lin, null]);
      expect(bound(h.payload)).toEqual([target, null]);
      // A page created after the hold now has the slug: unbound, held for that page.
      expect(bound(h.reused)).toEqual([null, [reused]]);
      // The name moved to another page and a page has it again: unbound, held for both.
      expect(bound(h.movedAndReused)).toEqual([null, [mvOld, mvNew].sort((a, b) => a - b)]);
      // No candidate at all: unbound and not marked, matched by slug as before.
      expect(bound(h.never)).toEqual([null, null]);
      expect(bound(h.purged)).toEqual([null, null]);
      expect(bound(h.blank)).toEqual([null, null]);
      // Identical twins under two names of one page merge into the earlier hold, adding the sightings; its twin's receipt goes with it.
      expect(bound(h.twinOld)).toEqual([tw, null]);
      expect(by.get(h.twinOld)!.seen_count).toBe(5);
      expect(by.has(h.twinNew)).toBe(false);
      expect(await engine.executeRaw("SELECT 1 FROM write_gate_receipts WHERE target_table='write_gate_holds' AND target_id=$1", [String(h.twinNew)])).toEqual([]);
      expect((await engine.executeRaw("SELECT 1 FROM write_gate_receipts WHERE target_table='write_gate_holds' AND target_id=$1", [String(h.twinOld)])).length).toBe(1);
      // Twins that differ are both kept: the earlier stays bound, the other is held for that page and listed.
      expect(bound(h.diffOld)).toEqual([td, null]);
      expect(bound(h.diffNew)).toEqual([null, [td]]);

      // The dedupe key moved to the two disjoint partial indexes; the old one is gone.
      const indexes = (await engine.executeRaw<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename='write_gate_holds' ORDER BY indexname")).map(i => i.indexname);
      expect(indexes).toContain('write_gate_holds_bound_dedupe_idx');
      expect(indexes).toContain('write_gate_holds_unbound_dedupe_idx');
      expect(indexes).not.toContain('write_gate_holds_dedupe_idx');

      // Decision K, retried migration: running it again (the version counter put back) changes nothing.
      const before = await holdStates(engine, sourceId);
      await engine.setConfig('version', '332');
      expect((await runMigrations(engine)).applied).toBeGreaterThanOrEqual(1);
      expect(await holdStates(engine, sourceId)).toEqual(before);
    }, 240_000);
    // Pins review finding 6: renames made before the rename history existed (v285) live only in slug_aliases. The backfill reads both, so a hold
    // whose page was renamed then still binds to that page (its moved fence row stays hidden), and a name taken by another page afterwards
    // stays uncertain: the hold is held for both pages and listed.
    test('alias-only rename lineage: the hold binds to the renamed page, and a reused name stays uncertain', async () => {
      const engine = brain();
      const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
      const page = async (slug: string) => {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: bareBody(ROWS), timeline: '' }, { sourceId });
        return Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.id);
      };
      const idOf = async (slug: string) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.id);
      await page('notes/old-a');
      const clean = await holdFenceRow(engine, { sourceId, slug: 'notes/old-a', claim: HELD, rowNum: 1 });
      expect(await engine.updateSlug('notes/old-a', 'notes/new-a', { sourceId })).toBe(1);
      await page('notes/old-b');
      const reusedHold = await holdFenceRow(engine, { sourceId, slug: 'notes/old-b', claim: HELD, rowNum: 1 });
      expect(await engine.updateSlug('notes/old-b', 'notes/new-b', { sourceId })).toBe(1);
      const reusedPage = await page('notes/old-b');
      const newA = await idOf('notes/new-a'), newB = await idOf('notes/new-b');
      // A brain from before v285: the rename record is only the alias.
      await engine.executeRaw('DELETE FROM slug_rename_history WHERE source_id=$1', [sourceId]);
      expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM slug_aliases WHERE source_id=$1 AND notes='rename'", [sourceId]))[0]!.n).toBeGreaterThanOrEqual(2);

      await toV332(engine);
      await runMigrations(engine);

      const by = new Map((await holdStates(engine, sourceId)).map(s => [s.id, s]));
      expect([by.get(clean)!.page_id, by.get(clean)!.page_candidates]).toEqual([newA, null]);
      expect([by.get(reusedHold)!.page_id, by.get(reusedHold)!.page_candidates]).toEqual([null, [reusedPage, newB].sort((a, b) => a - b)]);
      await expectHeldHidden(engine, sourceId, 'notes/new-a');
      await expectHeldHidden(engine, sourceId, 'notes/new-b');
    }, 240_000);
  });

  // Pins decision K: a brain whose write_gate_holds predates the columns upgrades through initSchema (bootstrap, blob replay, migration).
  describe(`pre-column upgrade replay (${backend})`, () => {
    // Its own brain: the test takes it back to v332 and replays the schema over it.
    let engine: BrainEngine, close: () => Promise<void>;
    beforeAll(async () => {
      // Cold PGLite: the unit runner's schema-snapshot fast path (GBRAIN_PGLITE_SNAPSHOT) would skip the replay this case pins.
      if (backend === 'pglite') { const e = new PGLiteEngine(); await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => { await e.connect({}); await e.initSchema(); }); engine = e; close = () => e.disconnect(); }
      else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4); engine = pg.engine; close = pg.close; }
    }, 180_000);
    afterAll(async () => { await close(); });

    test('initSchema on a brain at v333 adds the columns before the blob names them, then v333 runs', async () => {
      const sourceId = 'default';
      await toV332(engine);
      const [old] = await engine.executeRaw<{ id: string }>(
        `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload) VALUES ('fact', $1, 'notes/early', 'fp-early', 2, 'external_untrusted', '{"fact":"early"}'::jsonb) RETURNING id::text AS id`, [sourceId]);
      expect((await engine.executeRaw("SELECT 1 FROM information_schema.columns WHERE table_name='write_gate_holds' AND column_name='page_id'")).length).toBe(0);

      await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, () => engine.initSchema());

      const columns = (await engine.executeRaw<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='write_gate_holds' AND column_name IN ('page_id','page_candidates') ORDER BY 1")).map(c => c.column_name);
      expect(columns).toEqual(['page_candidates', 'page_id']);
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      expect((await holdStates(engine, sourceId)).find(s => s.id === Number(old!.id))).toMatchObject({ page_id: null, page_candidates: null, slug: 'notes/early' });
      const indexes = (await engine.executeRaw<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename='write_gate_holds'")).map(i => i.indexname);
      expect(indexes).toContain('write_gate_holds_bound_dedupe_idx');
      expect(indexes).not.toContain('write_gate_holds_dedupe_idx');
    }, 240_000);
  });
}
