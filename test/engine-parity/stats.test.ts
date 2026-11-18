/**
 * BrainEngine parity — stats family without chunk vectors (getStats, getHealth, logIngest, getIngestLog,
 * listEnrichCandidates, findAnomalies).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the brain counters, the health report and its score parts, the ingest log, the enrich candidates and
 *    the anomaly cohorts return the same observable result on every engine arm, for brains that hold no embeddings.
 *  - Regression: an engine that drifts on scoped counting (an empty `sourceIds` matches nothing), dead links, entity
 *    coverage, the orphan policy, the ingest log's not-null columns and JSONB form, the enrich filters and orders, or the
 *    anomaly baseline window. These are what `gbrain stats`, `doctor`, enrich and the dream cycle read.
 *  - Why existing coverage misses it: config-ingest.test.ts and code-eval-salience.test.ts write embeddings in most
 *    stats cases, so an engine that keeps no vectors stops on a refusal before it reaches the counters; and none of them
 *    covers the empty scope, dead links, the entity coverage threshold or the ingest log's failure paths.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, pick, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HEALTH_KEYS = [
  'page_count', 'linkable_page_count', 'embed_coverage', 'stale_pages', 'orphan_pages', 'missing_embeddings',
  'brain_score', 'dead_links', 'entity_page_count', 'entity_types_status', 'link_coverage', 'timeline_coverage',
  'most_connected', 'embed_coverage_score', 'link_density_score', 'timeline_coverage_score', 'no_orphans_score',
  'no_dead_links_score',
] as const;

/** What a failed call shows a caller: its message, or the fact it resolved. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  return run().then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : String(e)));
}

describe('engine parity: stats without vectors', () => {
  parityTest(
    'getStats counts chunks, links, tags and timeline entries, by scope, and an empty sourceIds matches nothing',
    { methods: ['putPage', 'upsertChunks', 'addLink', 'addTag', 'addTimelineEntry', 'softDeletePage', 'getStats'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'stats-b');
      await engine.putPage('people/s-alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice.', timeline: '' });
      await engine.putPage('companies/s-acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme.', timeline: '' });
      await engine.putPage('notes/s-gone', { type: 'note', title: 'Gone', compiled_truth: 'Gone.', timeline: '' });
      await engine.putPage('notes/s-other', { type: 'note', title: 'Other', compiled_truth: 'Other.', timeline: '' }, { sourceId: 'stats-b' });
      await engine.upsertChunks('people/s-alice', [
        { chunk_index: 0, chunk_text: 'Alice.', chunk_source: 'compiled_truth' },
        { chunk_index: 1, chunk_text: 'Alice later.', chunk_source: 'timeline' },
      ]);
      await engine.upsertChunks('notes/s-gone', [{ chunk_index: 0, chunk_text: 'Gone.', chunk_source: 'compiled_truth' }]);
      await engine.upsertChunks('notes/s-other', [{ chunk_index: 0, chunk_text: 'Other.', chunk_source: 'compiled_truth' }], { sourceId: 'stats-b' });
      await engine.addLink('people/s-alice', 'companies/s-acme', '', 'works_at');
      await engine.addLink('notes/s-gone', 'people/s-alice', '', 'mentions');
      await engine.addTag('people/s-alice', 'founder');
      await engine.addTag('notes/s-gone', 'archive');
      await engine.addTag('notes/s-other', 'founder', { sourceId: 'stats-b' });
      await engine.addTimelineEntry('people/s-alice', { date: '2026-01-02', summary: 'Joined', detail: '' });
      await engine.addTimelineEntry('people/s-alice', { date: '2026-02-03', summary: 'Left', detail: '' });
      await engine.softDeletePage('notes/s-gone');
      const whole = await engine.getStats();
      const def = await engine.getStats({ sourceId: 'default' });
      const other = await engine.getStats({ sourceIds: ['stats-b'] });
      const both = await engine.getStats({ sourceIds: ['stats-b', 'default'] });
      const none = await engine.getStats({ sourceIds: [] });
      const missing = await engine.getStats({ sourceId: 'no-such-source' });
      expect(none.page_count).toBe(0);
      expect(whole.embedded_count).toBe(0);
      return { whole, def, other, both, none, missing };
    },
  );

  parityTest(
    'getHealth counts dead links, entity coverage over the threshold, orphans and the most connected pages',
    { methods: ['putPage', 'addLink', 'addTimelineEntry', 'deletePage', 'getHealth'] },
    async (engine) => {
      const empty = pick(await engine.getHealth(), HEALTH_KEYS);
      for (let i = 0; i < 6; i++) {
        await engine.putPage(`people/h-${i}`, { type: 'person', title: `P${i}`, compiled_truth: `Person ${i}.`, timeline: '' });
      }
      await engine.putPage('companies/h-co', { type: 'company', title: 'Co', compiled_truth: 'Co.', timeline: '' });
      await engine.putPage('notes/h-doomed', { type: 'note', title: 'Doomed', compiled_truth: 'Doomed.', timeline: '' });
      await engine.putPage('notes/h-island', { type: 'note', title: 'Island', compiled_truth: 'Island.', timeline: '' });
      await engine.addLink('people/h-0', 'companies/h-co', '', 'works_at');
      await engine.addLink('people/h-1', 'companies/h-co', '', 'works_at');
      await engine.addLink('people/h-2', 'people/h-0', '', 'knows');
      await engine.addLink('companies/h-co', 'people/h-3', '', 'employs');
      await engine.addLink('people/h-4', 'notes/h-doomed', '', 'mentions');
      await engine.addLink('people/h-4', 'people/h-4', '', 'self');
      await engine.addTimelineEntry('people/h-0', { date: '2026-01-01', summary: 'Joined', detail: '' });
      await engine.addTimelineEntry('people/h-5', { date: '2026-01-02', summary: 'Met', detail: '' });
      await engine.deletePage('notes/h-doomed');
      const health = pick(await engine.getHealth(), HEALTH_KEYS);
      expect(health.entity_page_count).toBe(7);
      expect(health.link_coverage).not.toBeNull();
      return { empty, health };
    },
  );

  parityTest(
    'getHealth by scope: below the entity threshold, an unknown source and an empty sourceIds',
    { methods: ['putPage', 'addLink', 'getHealth'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'health-b');
      await engine.putPage('people/hs-a', { type: 'person', title: 'A', compiled_truth: 'A.', timeline: '' });
      await engine.putPage('people/hs-b', { type: 'person', title: 'B', compiled_truth: 'B.', timeline: '' }, { sourceId: 'health-b' });
      await engine.putPage('notes/hs-c', { type: 'note', title: 'C', compiled_truth: 'C.', timeline: '' }, { sourceId: 'health-b' });
      await engine.addLink('notes/hs-c', 'people/hs-b', '', 'mentions', undefined, undefined, undefined, { fromSourceId: 'health-b', toSourceId: 'health-b' });
      await engine.addLink('people/hs-a', 'people/hs-b', '', 'knows', undefined, undefined, undefined, { toSourceId: 'health-b' });
      const view = async (opts?: { sourceId?: string; sourceIds?: string[] }) => pick(await engine.getHealth(opts), HEALTH_KEYS);
      return {
        def: await view({ sourceId: 'default' }),
        other: await view({ sourceIds: ['health-b'] }),
        both: await view({ sourceIds: ['default', 'health-b', 'default'] }),
        none: await view({ sourceIds: [] }),
        unknown: await view({ sourceId: 'no-such-source' }),
      };
    },
  );

  parityTest(
    'logIngest stores JSON values and refuses missing columns; getIngestLog limits and scopes',
    { methods: ['logIngest', 'getIngestLog'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'log-b');
      await engine.logIngest({ source_type: 'markdown', source_ref: 'a.md', pages_updated: { b: [1, 2], a: 'x' } as never, summary: 'one' });
      await engine.logIngest({ source_id: 'log-b', source_type: 'git', source_ref: 'repo@1', pages_updated: [], summary: 'two' });
      // Each missing column must be refused and leave no row. The refusal text differs by driver (PGLite
      // names the NOT NULL column, postgres.js only the undefined parameter), so it is not compared.
      const refusedLeavingNoRow = async (entry: unknown) => {
        const before = (await engine.getIngestLog()).length;
        const refused = await engine.logIngest(entry as never).then(() => false, () => true);
        return { refused, saved: (await engine.getIngestLog()).length - before };
      };
      const missingType = await refusedLeavingNoRow({ source_ref: 'b.md', pages_updated: [], summary: 's' });
      const missingPages = await refusedLeavingNoRow({ source_type: 'x', source_ref: 'b.md', summary: 's' });
      const missingSummary = await refusedLeavingNoRow({ source_type: 'x', source_ref: 'b.md', pages_updated: [] });
      for (const o of [missingType, missingPages, missingSummary]) expect(o).toEqual({ refused: true, saved: 0 });
      const all = await engine.getIngestLog();
      const one = await engine.getIngestLog({ limit: 1 });
      const zero = await engine.getIngestLog({ limit: 0 });
      const scoped = await engine.getIngestLog({ sourceIds: ['log-b'] });
      const unscoped = await engine.getIngestLog({ sourceIds: [] });
      const view = (rows: Awaited<ReturnType<typeof engine.getIngestLog>>) =>
        sorted(rows.map((e) => pick(e, ['source_id', 'source_type', 'source_ref', 'pages_updated', 'summary'] as const)), (e) => e.summary);
      expect(all).toHaveLength(2);
      expect(all.every((e) => e.created_at instanceof Date)).toBe(true);
      return {
        missingType, missingPages, missingSummary,
        all: view(all), one: one.length, zero: zero.length, scoped: view(scoped), unscoped: unscoped.length,
      };
    },
  );

  parityTest(
    'listEnrichCandidates skips deleted, enriched, dream-generated and thick pages, and skips mentions and amends links',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'listEnrichCandidates'] },
    async (engine) => {
      await engine.putPage('people/e-plain', { type: 'person', title: 'Plain', compiled_truth: 'Short.', timeline: 'Then.' });
      await engine.putPage('people/e-fresh', { type: 'person', title: 'Fresh', compiled_truth: 'Short.', timeline: '', frontmatter: { enriched_at: '2999-01-01T00:00:00Z' } });
      await engine.putPage('people/e-stale', { type: 'person', title: 'Stale', compiled_truth: 'Short.', timeline: '', frontmatter: { enriched_at: '2000-01-01T00:00:00Z' } });
      await engine.putPage('people/e-dream', { type: 'person', title: 'Dream', compiled_truth: 'Short.', timeline: '', frontmatter: { dream_generated: true } });
      await engine.putPage('people/e-gone', { type: 'person', title: 'Gone', compiled_truth: 'Short.', timeline: '' });
      await engine.putPage('people/e-thick', { type: 'person', title: 'Thick', compiled_truth: 'x'.repeat(300), timeline: '' });
      await engine.putPage('notes/e-src', { type: 'note', title: 'Src', compiled_truth: 'Source.', timeline: '' });
      await engine.addLink('notes/e-src', 'people/e-stale', '', 'mentions_person');
      await engine.addLink('notes/e-src', 'people/e-plain', '', 'amends');
      await engine.addLink('notes/e-src', 'people/e-fresh', '', 'knows', 'mentions');
      await engine.softDeletePage('people/e-gone');
      const view = (rows: Awaited<ReturnType<typeof engine.listEnrichCandidates>>) =>
        rows.map((r) => `${r.source_id}:${r.slug}|${r.type}|${r.title}|${r.body_len}|${r.inbound_count}`);
      const base = { types: ['person' as const], thinThreshold: 100, order: 'inbound-links' as const, limit: 50 };
      return {
        byInbound: view(await engine.listEnrichCandidates(base)),
        reenrich: view(await engine.listEnrichCandidates({ ...base, reenrichAfterMs: 86_400_000 })),
        salience: view(await engine.listEnrichCandidates({ ...base, order: 'salience' })),
        tiny: view(await engine.listEnrichCandidates({ ...base, thinThreshold: 7 })),
        unknownOrder: view(await engine.listEnrichCandidates({ ...base, order: 'nope' as never })),
        emptyScope: view(await engine.listEnrichCandidates({ ...base, sourceIds: [] })),
      };
    },
  );

  parityTest(
    'findAnomalies with no activity, an empty brain and a scope with no pages',
    { methods: ['putPage', 'addTag', 'findAnomalies'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'anomaly-b');
      const emptyBrain = await engine.findAnomalies({ since: '2026-03-01', lookback_days: 3 });
      for (let i = 0; i < 3; i++) {
        await engine.putPage(`notes/a-${i}`, { type: 'note', title: `A${i}`, compiled_truth: `A ${i}.`, timeline: '' });
        await engine.addTag(`notes/a-${i}`, i === 0 ? 'zeta' : 'alpha');
      }
      const today = new Date((await engine.getPage('notes/a-2'))!.updated_at).toISOString().slice(0, 10);
      const view = (rows: Awaited<ReturnType<typeof engine.findAnomalies>>) =>
        rows.map((r) => ({ ...pick(r, ['cohort_kind', 'cohort_value', 'count', 'baseline_mean', 'baseline_stddev'] as const), page_slugs: sorted(r.page_slugs) }));
      return {
        emptyBrain,
        found: sorted(view(await engine.findAnomalies({ since: today, lookback_days: 1 })), (r) => `${r.cohort_kind}:${r.cohort_value}`),
        emptyScope: view(await engine.findAnomalies({ since: today, sourceIds: ['anomaly-b'] })),
        tomorrow: view(await engine.findAnomalies({ since: new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10), lookback_days: 2 })),
        badDate: await outcome(() => engine.findAnomalies({ since: 'not-a-date' })),
      };
    },
  );
});
