/**
 * W5 time-model fixes (10x plan, wave 4a): an inferred closure is an upper bound and an explicit end replaces it,
 * on PGLite and on Postgres when DATABASE_URL is set; and the `since_supplied` probe the plan required before any
 * takes change (a late-captured take keeps its valid time, and an update without `since` keeps the stored one).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadRelationshipNotes, relationshipNoteKey } from '../src/core/link-relationship-notes.ts';
import { refreshRelationships } from '../src/core/link-relationships.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, type BeliefBrain } from './helpers/belief-ledger.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { assertLegacyEngineMigration } from '../src/core/persistence/maintenance.ts';

const person = (lines: string[]) => ['---', 'type: person', 'title: Alice Example', '---', 'Alice is CTO of Widget.', '', '## Timeline', '', ...lines, ''].join('\n');
const JOINED_ACME = '- **2019-02-01** | linkedin — Joined [Acme](../companies/acme-example) as CTO';
const JOINED_WIDGET = '- **2025-03-01** | linkedin — Joined [Widget](../companies/widget-co) as CTO';
const INFERRED = '- **2025-03-01** | gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)';
const note = async (b: BeliefBrain) => (await loadRelationshipNotes(b.engine, [{ slug: 'people/alice-example', source_id: b.sourceId, summary: '' }], { excludePrivate: false }))
  .get(relationshipNoteKey(b.sourceId, 'people/alice-example'));
const takes = async (b: BeliefBrain, slug: string) => b.engine.executeRaw<{ row_num: number; since_date: string | null; weight: number }>(
  'SELECT t.row_num, t.since_date::text AS since_date, t.weight FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1 AND p.slug = $2 ORDER BY t.row_num', [b.sourceId, slug]);

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`W5 time model (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>) => beliefBrain(run, { managed: true, databaseUrl: engineCase.databaseUrl });
    // A bare brain (no managed persistence rows) for the legacy copier cell.
    let bare: { engine: BrainEngine; close: () => Promise<void> };
    beforeAll(async () => {
      if (engineCase.databaseUrl) { bare = await isolatedPersistencePostgres(engineCase.databaseUrl); return; }
      const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema();
      bare = { engine: pglite, close: () => pglite.disconnect() };
    }, 120_000);
    afterAll(async () => { await bare?.close(); });

    test('a closure only the nightly check dated reads as an upper bound; an explicit end on either side of it replaces it', () => brain(async b => {
      await b.put('companies/acme-example', '---\ntype: company\ntitle: Acme\n---\nA company.\n');
      await b.put('companies/widget-co', '---\ntype: company\ntitle: Widget\n---\nAnother company.\n');
      await b.put('people/alice-example', person([JOINED_ACME, JOINED_WIDGET, INFERRED]));
      expect(await note(b)).toContain('ended: works_at acme-example (by 2025-03-01)');
      const [acme] = await b.engine.executeRaw<{ last_end: string }>(`SELECT lr.last_end::text AS last_end FROM link_relationships lr
        JOIN pages t ON t.id = lr.to_page_id WHERE t.source_id = $1 AND t.slug = 'companies/acme-example' AND lr.scope = 'all'`, [b.sourceId]);
      expect(acme!.last_end).toBe('2025-03-01');
      // The gap: an explicit end before the next job dates it exactly.
      await b.put('people/alice-example', person([JOINED_ACME, '- **2024-06-01** | linkedin — Left [Acme](../companies/acme-example)', JOINED_WIDGET, INFERRED]));
      expect(await note(b)).toContain('ended: works_at acme-example (2024-06-01)');
      // An explicit end after the inferred closure (a notice period) replaces it too; before W5 the earlier inferred date won.
      await b.put('people/alice-example', person([JOINED_ACME, JOINED_WIDGET, INFERRED, '- **2025-06-01** | linkedin — Left [Acme](../companies/acme-example)']));
      expect(await note(b)).toContain('ended: works_at acme-example (2025-06-01)');
    }), 120_000);

    test('a private page\'s explicit end does not turn the world-scope upper bound exact (remote notes)', () => brain(async b => {
      await b.put('companies/acme-example', '---\ntype: company\ntitle: Acme\n---\nA company.\n');
      await b.put('companies/widget-co', '---\ntype: company\ntitle: Widget\n---\nAnother company.\n');
      await b.put('people/alice-example', person([JOINED_ACME, JOINED_WIDGET, INFERRED]));
      await b.put('notes/hr-private', '---\ntype: note\ntitle: HR\nvisibility: private\n---\nPrivate HR note.\n');
      const ids = Object.fromEntries((await b.engine.executeRaw<{ slug: string; id: number }>(
        'SELECT slug, id FROM pages WHERE source_id = $1', [b.sourceId])).map(r => [r.slug, r.id]));
      await b.engine.executeRaw(`INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
        VALUES ($1, $2, $3, 'works_at', 'end', '2025-03-01', 'explicit', $4)`, [b.sourceId, ids['people/alice-example'], ids['companies/acme-example'], ids['notes/hr-private']]);
      await refreshRelationships(b.engine, [{ from_page_id: ids['people/alice-example']!, to_page_id: ids['companies/acme-example']!, link_type: 'works_at' }]);
      const notes = async (excludePrivate: boolean) => (await loadRelationshipNotes(b.engine,
        [{ slug: 'people/alice-example', source_id: b.sourceId, summary: '' }], { excludePrivate })).get(relationshipNoteKey(b.sourceId, 'people/alice-example'));
      expect(await notes(true)).toContain('ended: works_at acme-example (by 2025-03-01)');
      expect(await notes(false)).toContain('ended: works_at acme-example (2025-03-01)');
    }), 120_000);

    test('the legacy engine copier refuses a brain whose page versions it would discard, and names how many', async () => {
      const { engine } = bare;
      {
        const side = { side: 'source' as const, from: engine.kind as 'pglite' | 'postgres', to: (engine.kind === 'pglite' ? 'postgres' : 'pglite') as 'pglite' | 'postgres' };
        await assertLegacyEngineMigration(engine, side);
        await engine.putPage('notes/history', { type: 'note', title: 'History', compiled_truth: 'first body' });
        for (let i = 0; i < 3; i++) await engine.createVersion('notes/history');
        await expect(assertLegacyEngineMigration(engine, side)).rejects.toMatchObject({
          code: 'writer_coordinator_required', reason: 'page_history', message: 'Engine migration would discard 3 page versions.' });
      }
    }, 120_000);

    test('since_supplied probe: a late-captured take keeps its valid time, and an update without since keeps the stored one', () => brain(async b => {
      const slug = 'companies/acme-example';
      await b.put(slug, '---\ntype: company\ntitle: Acme\n---\nA company.\n');
      const added = await b.op('takes_add', { slug, claim: 'Acme will double revenue', kind: 'bet', holder: 'brain', weight: 0.6, since: '2020-05-01' });
      expect(added).toMatchObject({ row_num: 1 });
      expect(await takes(b, slug)).toEqual([{ row_num: 1, since_date: '2020-05-01', weight: 0.6 }]);
      await b.op('takes_update', { slug, row_num: 1, weight: 0.8 });
      expect(await takes(b, slug)).toEqual([{ row_num: 1, since_date: '2020-05-01', weight: 0.8 }]);
      const today = new Date().toISOString().slice(0, 10);
      await b.op('takes_add', { slug, claim: 'Acme will hire a CFO', kind: 'bet', holder: 'brain', weight: 0.5 });
      expect((await takes(b, slug))[1]).toMatchObject({ row_num: 2, since_date: today });
    }), 120_000);
  });
}
