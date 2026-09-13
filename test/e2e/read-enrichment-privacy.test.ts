import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageReadPolicy, SearchResult } from '../../src/core/types.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { findExperts } from '../../src/commands/whoknows.ts';
import { applySupersedeDownrank, runPostFusionStages, _resetSupersedeProbeForTests } from '../../src/core/search/hybrid.ts';
import { applyGraphSignals } from '../../src/core/search/graph-signals.ts';
import { buildRelationalArm } from '../../src/core/search/relational-recall.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { readBacklinkCounts, type ReadQuery } from '../../src/core/search/read-enrichment.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';

// Whole-engine initialization, synthetic source-scoped fixtures, no shared DB
// truncation. Every assertion below runs against PGLite and real Postgres.
const [A, B, FOREIGN, ARCHIVED] = ['enrichment-a', 'enrichment-b', 'enrichment-foreign', 'enrichment-archived'];
const SOURCES = [A, B, FOREIGN, ARCHIVED];
const policy: PageReadPolicy = { sourceIds: [A, B, ARCHIVED], excludePrivate: true, takesHoldersAllowList: ['reader'] };
const key = (slug: string, source = A) => `${source}::${slug}`;
const ref = (slug: string, source = A) => ({ slug, source_id: source });

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: read enrichment privacy`, () => {
    let engine: BrainEngine;

    beforeAll(async () => {
      // Explicitly keyless: findExperts exercises the real keyword pipeline.
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      await engine.connect(kind === 'postgres' ? { database_url: process.env.DATABASE_URL! } : {});
      await engine.initSchema();
      for (const source of SOURCES) {
        await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
      }
    }, 120_000);

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages WHERE source_id = ANY($1::text[])', [SOURCES]);
      await engine.executeRaw('UPDATE sources SET archived = FALSE WHERE id = ANY($1::text[])', [SOURCES]);
      _resetSupersedeProbeForTests();
    });

    afterAll(async () => {
      if (engine) {
        try { await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [SOURCES]); }
        finally { await engine.disconnect(); }
      }
      resetGateway();
    }, 60_000);

    async function page(slug: string, source = A, frontmatter: Record<string, unknown> = {}, type = 'note'): Promise<number> {
      await engine.putPage(slug, { type, title: slug, compiled_truth: `Public fixture ${slug}`, frontmatter }, { sourceId: source });
      const rows = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, source]);
      return Number(rows[0].id);
    }

    async function edge(from: number, to: number, origin: number | null = null, linkType = 'related', linkSource = 'manual') {
      await engine.executeRaw('INSERT INTO links (from_page_id, to_page_id, origin_page_id, link_type, link_source) VALUES ($1, $2, $3, $4, $5)', [from, to, origin, linkType, linkSource]);
    }

    async function take(id: number, row: number, holder: string, weight: number, active = true) {
      await engine.addTakesBatch([{ page_id: id, row_num: row, claim: 'Synthetic holder opinion', kind: 'take', holder, weight, active }]);
    }

    function result(slug: string, id: number, source = A): SearchResult {
      return { slug, page_id: id, source_id: source, title: slug, type: 'note', chunk_id: id, chunk_index: 0, chunk_text: 'public', chunk_source: 'compiled_truth', score: 1, stale: false } as SearchResult;
    }

    test('source-only policies reach post-fusion and graph-origin authorization', async () => {
      const target = await page('notes/scope-target');
      const first = await page('notes/scope-first');
      const second = await page('notes/scope-second');
      const foreign = await page('notes/scope-origin', FOREIGN);
      await edge(first, target, foreign);
      await edge(second, target, foreign);
      const opts = { applyBacklinks: true, salience: 'off', recency: 'off' } as const;
      const unscoped = [result('notes/scope-target', target)];
      await runPostFusionStages(engine, unscoped, opts);
      expect(unscoped[0].score).toBeGreaterThan(1);
      for (const scope of [{ sourceId: A }, { sourceIds: [A, B] }, { sourceId: A, sourceIds: [] }]) {
        const scoped = [result('notes/scope-target', target)];
        await runPostFusionStages(engine, scoped, { ...opts, ...scope });
        expect(scoped[0].score).toBe(1);
        const graph = [result('notes/scope-target', target), result('notes/scope-first', first), result('notes/scope-second', second)];
        await applyGraphSignals(graph, engine, { enabled: true, ...scope });
        expect(graph[0].score).toBe(1);
        expect(graph[0].graph_adjacency_hits).toBeUndefined();
      }
      const granted = [result('notes/scope-target', target), result('notes/scope-first', first), result('notes/scope-second', second)];
      await applyGraphSignals(granted, engine, { enabled: true, sourceIds: [A, FOREIGN] });
      expect(granted[0].graph_adjacency_hits).toBe(2);
      expect(granted[0].score).toBeGreaterThan(1);
    });

    test('relational retrieval authorizes private seeds, intermediate pages and actual origins before limits', async () => {
      const start = await page('people/relational-start');
      const bridge = await page('people/relational-a-private', A, { visibility: 'private' });
      await page('people/relational-a-private', B); // A public namesake cannot authorize the bridge.
      const beyond = await page('people/relational-beyond');
      const visible = await page('people/relational-visible');
      const hiddenOrigin = await page('people/relational-hidden-origin', B, { visibility: 'private' });
      const foreignOrigin = await page('people/relational-foreign-origin', FOREIGN);
      const grantedOrigin = await page('people/relational-granted-origin', B);
      const hiddenTarget = await page('people/relational-hidden-target');
      const foreignTarget = await page('people/relational-foreign-target');
      await edge(start, bridge);
      await edge(bridge, beyond);
      await edge(start, visible, grantedOrigin);
      await edge(start, hiddenTarget, hiddenOrigin);
      await edge(start, foreignTarget, foreignOrigin);
      const scope = { sourceIds: [A, B], excludePrivate: true, takesHoldersAllowList: ['world'] };
      const list = await buildRelationalArm(engine, 'who introduced me to people/relational-start', { ...scope, depth: 2, limit: 1 });
      expect(list.map(row => row.slug)).toEqual(['people/relational-visible']);
      expect(list[0].relational_path).toEqual(['people/relational-start', 'people/relational-visible']);
      expect(await buildRelationalArm(engine, 'who introduced me to people/relational-hidden-origin', scope)).toEqual([]);
      const unrestricted = await engine.relationalFanout(['people/relational-start']);
      expect(unrestricted.map(row => row.slug)).toContain('people/relational-a-private');
      expect(unrestricted.map(row => row.slug)).toContain('people/relational-beyond');
      expect(unrestricted.map(row => row.slug)).toContain('people/relational-hidden-target');
      expect(unrestricted.map(row => row.slug)).toContain('people/relational-foreign-target');
      expect((await engine.relationalFanout(['people/relational-start'], { sourceIds: [A, B, FOREIGN], excludePrivate: true })).map(row => row.slug)).toContain('people/relational-foreign-target');
    });

    test('relational snippets sanitize every protected fence before truncation, including page-visibility opt-outs', async () => {
      const start = await page('people/snippet-start');
      const target = await page('people/snippet-target');
      await edge(start, target);
      const take = `${TAKES_FENCE_BEGIN}\n${'PRIVATE_RELATIONAL_TAKE '.repeat(30)}\n${TAKES_FENCE_END}`;
      await engine.executeRaw('UPDATE pages SET compiled_truth = $2 WHERE id = $1', [target, `${take}\n${take}\nPUBLIC_RELATIONAL_SNIPPET`]);
      for (const excludePrivate of [true, false]) {
        const rows = await buildRelationalArm(engine, 'who introduced me to people/snippet-start', { sourceId: A, excludePrivate, takesHoldersAllowList: [] });
        expect(rows).toHaveLength(1);
        expect(rows[0].chunk_text).toContain('PUBLIC_RELATIONAL_SNIPPET');
        expect(rows[0].chunk_text).not.toContain('PRIVATE_RELATIONAL_TAKE');
        expect(rows[0].chunk_text.length).toBeLessThanOrEqual(240);
      }
    });

    test('remote title admission cannot depend on protected timeline terms in the page vector', async () => {
      const slug = 'notes/title-privacy-example';
      await importFromContent(engine, slug, serializeMarkdown({}, 'Public title-search body.',
        `${TAKES_FENCE_BEGIN}\nnegationcanary\n${TAKES_FENCE_END}`,
        { type: 'note', title: 'titleprobe example', tags: [] }), { sourceId: A, noEmbed: true, forceRechunk: true });
      const query = 'titleprobe -negationcanary';
      const [raw] = await engine.executeRaw<{ matched: boolean }>(
        "SELECT search_vector @@ websearch_to_tsquery('english', $1) AS matched FROM pages WHERE source_id = $2 AND slug = $3", [query, A, slug]);
      expect(raw.matched).toBe(false); // The old full-page prefilter would reject it.
      for (const excludePrivate of [true, false]) {
        const rows = await engine.searchTitles(query, { sourceId: A, requireSafeChunks: true, excludePrivate });
        expect(rows.map(row => row.slug)).toEqual([slug]);
        expect(JSON.stringify(rows)).not.toContain('negationcanary');
      }
    });

    test('backlinks and adjacency authorize contributors, targets and independent origins', async () => {
      const target = await page('notes/target');
      const allowed = await page('notes/allowed');
      const crossSource = await page('notes/cross-source', B);
      const hidden = await page('notes/hidden', A, { visibility: 'private' });
      const foreign = await page('notes/foreign', FOREIGN);
      const archived = await page('notes/archived', ARCHIVED);
      const deleted = await page('notes/deleted');
      const quarantined = await page('notes/quarantined', A, { quarantine: { reason: 'fixture' } });
      const originCarrier = await page('notes/origin-carrier');
      for (const id of [allowed, crossSource, hidden, foreign, archived, deleted, quarantined]) await edge(id, target);
      await edge(originCarrier, target, hidden);
      await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [deleted]);
      await engine.executeRaw('UPDATE sources SET archived = TRUE WHERE id = $1', [ARCHIVED]);
      const ids = [target, allowed, crossSource, hidden, foreign, archived, deleted, quarantined, originCarrier];

      expect((await engine.getBacklinkCounts(ids, policy)).get(target)).toBe(2);
      expect((await engine.getAdjacencyBoosts(ids, policy)).get(target)).toEqual({ hits: 2, cross_source_hits: 1 });
      expect((await engine.getBacklinkCounts([target])).get(target)).toBe(8); // Trusted local control.
      // An empty source array preserves the scalar floor; a nonempty grant wins.
      expect((await engine.getBacklinkCounts([target], { ...policy, sourceIds: [], sourceId: A })).get(target)).toBe(1);
      expect((await engine.getBacklinkCounts([target], { ...policy, sourceId: FOREIGN })).get(target)).toBe(2);

      await engine.executeRaw("UPDATE pages SET frontmatter = '{\"visibility\":\"private\"}'::jsonb WHERE id = $1", [target]);
      expect((await engine.getBacklinkCounts([target], policy)).get(target)).toBe(0);
      expect(await engine.getAdjacencyBoosts(ids, policy)).toEqual(new Map());
    });

    test('superseders cannot disclose private endpoints or private/foreign origins', async () => {
      const hiddenOrigin = await page('notes/hidden-origin', B, { visibility: 'private' });
      const foreignOrigin = await page('notes/foreign-origin', FOREIGN);
      const ids: number[] = [];
      for (const variant of ['allowed', 'hidden', 'foreign', 'deleted', 'quarantined', 'hidden-origin', 'foreign-origin']) {
        const target = await page(`notes/old-${variant}`);
        const from = await page(`notes/new-${variant}`, variant === 'foreign' ? FOREIGN : A,
          variant === 'hidden' ? { visibility: 'private' } : variant === 'quarantined' ? { quarantine: {} } : {});
        if (variant === 'deleted') await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [from]);
        await edge(from, target, variant === 'hidden-origin' ? hiddenOrigin : variant === 'foreign-origin' ? foreignOrigin : null, 'supersedes');
        ids.push(target);
      }
      const rows = ids.map((id, i) => result(`notes/old-${i}`, id));
      await applySupersedeDownrank(rows, engine, policy);
      expect(rows.filter(r => r.superseded).map(r => r.superseded_by)).toEqual(['notes/new-allowed']);
      expect(rows.slice(1).every(r => r.score === 1 && r.superseded_by === undefined)).toBe(true);
      const local = [result('notes/local-control', ids[5])];
      await applySupersedeDownrank(local, engine);
      expect(local[0].superseded_by).toBe('notes/new-hidden-origin');
    });

    test('stale candidate IDs and same-slug refs cannot read flags, extraction state or dates after revocation', async () => {
      const fm = { content_flag: { reason: 'fixture', detail: 'VISIBLE_FLAG' }, provenance: 'auto-extracted', status: 'unverified' };
      const visible = await page('notes/shared', A, fm);
      const hidden = await page('notes/shared', B, { ...fm, visibility: 'private' });
      const foreign = await page('notes/shared', FOREIGN, fm);
      const archived = await page('notes/shared', ARCHIVED, fm);
      await engine.executeRaw('UPDATE sources SET archived = TRUE WHERE id = $1', [ARCHIVED]);
      const ids = [visible, hidden, foreign, archived];
      const refs = SOURCES.map(source => ref('notes/shared', source));
      expect([...(await engine.getContentFlagsByPageIds(ids, policy)).keys()]).toEqual([visible]);
      expect([...(await engine.getUnverifiedExtractionPageIds(ids, policy)).keys()]).toEqual([visible]);
      expect([...(await engine.getEffectiveDates(refs, policy)).keys()]).toEqual([key('notes/shared')]);
      expect((await engine.getEffectiveDates(refs)).size).toBe(4);
      expect((await engine.getEffectiveDates(refs, { sourceId: A, sourceIds: [], excludePrivate: true })).size).toBe(1);
      await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"visibility\":\"private\"}'::jsonb WHERE id = $1", [visible]);
      expect(await engine.getContentFlagsByPageIds(ids, policy)).toEqual(new Map());
      expect(await engine.getUnverifiedExtractionPageIds(ids, policy)).toEqual(new Map());
      expect(await engine.getEffectiveDates(refs, policy)).toEqual(new Map());
    });

    test('forbidden-holder writes cannot affect restricted scores, counters or the recent window', async () => {
      const current = await page('notes/salient');
      const old = await page('notes/old-salient');
      const currentRef = ref('notes/salient');
      await take(current, 0, 'reader', 0.25);
      await take(current, 1, 'owner', 0.75);
      await take(current, 2, 'reader', 1, false);
      await take(old, 0, 'owner', 0.75);
      await engine.executeRaw("UPDATE pages SET updated_at = now() - interval '40 days', salience_touched_at = now() - interval '40 days' WHERE id = $1", [old]);
      await engine.setEmotionalWeightBatch([{ ...currentRef, weight: 0.5 }]);
      const before = (await engine.getRecentSalience({ ...policy, days: 7, limit: 100 })).find(r => r.slug === currentRef.slug)!;
      expect(before.take_count).toBe(1);
      expect(before.take_avg_weight).toBe(0.25);
      expect(before.emotional_weight).toBe(0);
      expect((await engine.getSalienceScores([currentRef], policy)).get(key(currentRef.slug))).toBeCloseTo(Math.log(2), 12);

      await take(current, 3, 'owner', 1);
      await engine.setEmotionalWeightBatch([{ ...currentRef, weight: 0.875 }, { ...ref('notes/old-salient'), weight: 0.875 }]);
      const restricted = await engine.getRecentSalience({ ...policy, days: 7, limit: 100 });
      const after = restricted.find(r => r.slug === currentRef.slug)!;
      expect(after.take_count).toBe(before.take_count);
      expect(after.take_avg_weight).toBe(before.take_avg_weight);
      expect(after.emotional_weight).toBe(0);
      expect(new Date(after.updated_at).getTime()).toBe(new Date(before.updated_at).getTime());
      expect(after.score).toBeCloseTo(before.score, 4); // Only wall-clock recency can advance.
      expect(restricted.some(r => r.slug === 'notes/old-salient')).toBe(false);
      expect((await engine.getSalienceScores([currentRef], policy)).get(key(currentRef.slug))).toBeCloseTo(Math.log(2), 12);

      const local = await engine.getRecentSalience({ sourceId: A, days: 7, limit: 100 });
      expect(local.some(r => r.slug === 'notes/old-salient')).toBe(true);
      expect(local.find(r => r.slug === currentRef.slug)!.take_count).toBe(3);
      expect((await engine.getSalienceScores([currentRef])).get(key(currentRef.slug))).toBeCloseTo(0.875 * 5 + Math.log(4), 12);
      await take(current, 4, 'reader', 0.75);
      expect((await engine.getSalienceScores([currentRef], policy)).get(key(currentRef.slug))).toBeCloseTo(Math.log(3), 12);
      const empty = { ...policy, takesHoldersAllowList: [] };
      expect((await engine.getSalienceScores([currentRef], empty)).get(key(currentRef.slug))).toBe(0);
      const emptyRecent = (await engine.getRecentSalience({ ...empty, days: 7 })).find(r => r.slug === currentRef.slug)!;
      expect([emptyRecent.take_count, emptyRecent.take_avg_weight, emptyRecent.emotional_weight]).toEqual([0, 0, 0]);
    });

    test('recent salience excludes invisible rows before limit and keeps exact source identity', async () => {
      const visible = await page('notes/shared');
      await page('notes/shared', B, { visibility: 'private' });
      await page('notes/foreign', FOREIGN);
      await page('notes/archived', ARCHIVED);
      const deleted = await page('notes/deleted');
      await page('notes/quarantined', A, { quarantine: {} });
      await engine.executeRaw('UPDATE pages SET emotional_weight = 1 WHERE source_id = ANY($1::text[]) AND id <> $2', [SOURCES, visible]);
      await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [deleted]);
      await engine.executeRaw('UPDATE sources SET archived = TRUE WHERE id = $1', [ARCHIVED]);
      const rows = await engine.getRecentSalience({ ...policy, takesHoldersAllowList: undefined, days: 7, limit: 1 });
      expect(rows.map(r => key(r.slug, r.source_id))).toEqual([key('notes/shared')]);
      expect((await engine.getSalienceScores(SOURCES.map(source => ref('notes/shared', source)), policy)).size).toBe(1);
      const localPrivate = await engine.getRecentSalience({ sourceId: B, days: 7 });
      expect(localPrivate.map(r => key(r.slug, r.source_id))).toEqual([key('notes/shared', B)]);
      expect((await engine.getRecentSalience({ ...policy, sourceIds: [], sourceId: A, days: 7 })).map(r => r.slug)).toEqual(['notes/shared']);
    });

    test('anomaly baselines and totals count authorized page rows before the 50-slug display cap', async () => {
      const since = '2026-08-20';
      async function activity(slug: string, source: string, day: string, fm: Record<string, unknown> = {}, tag = 'public-cohort') {
        const id = await page(slug, source, fm);
        await engine.executeRaw('UPDATE pages SET updated_at = $1::timestamptz WHERE id = $2', [`${day}T12:00:00Z`, id]);
        await engine.executeRaw('INSERT INTO tags (page_id, tag) VALUES ($1, $2)', [id, tag]);
        return id;
      }
      for (let i = 0; i < 55; i++) await activity(`notes/current-${i}`, A, since);
      await activity('notes/current-0', B, since); // Same slug, distinct authorized page: total 56, display 50.
      for (let i = 0; i < 4; i++) await activity(`notes/baseline-${i}`, A, `2026-08-${16 + i}`);
      const opts = { ...policy, since, lookback_days: 4, sigma: 3 };
      const before = await engine.findAnomalies(opts);
      const cohort = before.find(r => r.cohort_kind === 'tag' && r.cohort_value === 'public-cohort')!;
      expect(cohort.count).toBe(56);
      expect(cohort.page_slugs).toHaveLength(50);
      expect([cohort.baseline_mean, cohort.baseline_stddev]).toEqual([1, 0]);

      for (const day of ['2026-08-16', since]) {
        await activity(`notes/private-${day}`, B, day, { visibility: 'private' });
        await activity(`notes/foreign-${day}`, FOREIGN, day);
        await activity(`notes/archived-${day}`, ARCHIVED, day);
        const deleted = await activity(`notes/deleted-${day}`, A, day);
        await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [deleted]);
        await activity(`notes/quarantined-${day}`, A, day, { quarantine: {} });
      }
      await activity('notes/secret-only-1', B, since, { visibility: 'private' }, 'PRIVATE_COHORT_CANARY');
      await activity('notes/secret-only-2', B, since, { visibility: 'private' }, 'PRIVATE_COHORT_CANARY');
      await engine.executeRaw('UPDATE sources SET archived = TRUE WHERE id = $1', [ARCHIVED]);
      const after = await engine.findAnomalies(opts);
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).not.toContain('PRIVATE_COHORT_CANARY');
      expect((await engine.findAnomalies({ ...opts, excludePrivate: false })).some(r => r.cohort_value === 'PRIVATE_COHORT_CANARY')).toBe(true);
      const scalar = await engine.findAnomalies({ ...opts, sourceIds: [], sourceId: A });
      expect(scalar.find(r => r.cohort_kind === 'tag')!.count).toBe(55);
    });

    for (const caller of ['remote', 'local scalar'] as const) {
      const expertSlug = 'people/expert-example';
      const opts = { ...(caller === 'remote' ? policy : { sourceId: A }), topic: 'nebularrouting', limit: 5 };

      async function seedExpert() {
        await importFromContent(engine, expertSlug, serializeMarkdown({}, 'Synthetic nebularrouting expertise specialist', '',
          { type: 'person', title: expertSlug, tags: [] }), { sourceId: A, noEmbed: true, forceRechunk: true });
        return (await engine.getPage(expertSlug, { sourceId: A }))!.id;
      }

      test(`${caller} experts recheck admission after salience completes a visibility/source edit`, async () => {
        const id = await seedExpert();
        expect((await findExperts(engine, opts)).map(r => r.slug)).toEqual([expertSlug]);
        const readScores = engine.getSalienceScores.bind(engine);
        const readDates = engine.getEffectiveDates.bind(engine);
        let editCompleted = false;
        try {
          engine.getSalienceScores = async (refs, scope) => {
            const scores = await readScores(refs, scope);
            if (caller === 'remote') {
              await engine.executeRaw("UPDATE pages SET frontmatter = '{\"visibility\":\"private\"}'::jsonb WHERE id = $1", [id]);
            } else {
              await engine.executeRaw('UPDATE pages SET source_id = $1 WHERE id = $2', [B, id]);
            }
            editCompleted = true;
            return scores;
          };
          engine.getEffectiveDates = async (refs, scope) => {
            // Pins the ordering independently of each engine's query scheduler:
            // an admission read started before this edit cannot authorize it.
            expect(editCompleted).toBe(true);
            return readDates(refs, scope);
          };
          expect(await findExperts(engine, opts)).toEqual([]);
        } finally {
          engine.getSalienceScores = readScores;
          engine.getEffectiveDates = readDates;
        }
      });

      test(`${caller} experts preserve salience factors and use the neutral factor when optional SQL fails`, async () => {
        const id = await seedExpert();
        await take(id, 0, 'reader', 0.25);
        await take(id, 1, 'owner', 0.75);
        await engine.setEmotionalWeightBatch([{ ...ref(expertSlug), weight: 0.5 }]);
        const baseline = await findExperts(engine, opts);
        expect(baseline.map(r => r.slug)).toEqual([expertSlug]);
        const rawSalience = caller === 'remote' ? Math.log(2) : 2.5 + Math.log(3);
        const normalized = rawSalience / (1 + rawSalience);
        expect(baseline[0].factors.salience).toBeCloseTo(normalized, 12);
        expect(baseline[0].factors.salience_factor).toBeCloseTo(0.5 + 0.5 * normalized, 12);
        const readScores = engine.getSalienceScores.bind(engine);
        try {
          engine.getSalienceScores = async () => {
            await engine.executeRaw('SELECT enrichment_missing_column FROM pages LIMIT 1');
            return new Map();
          };
          const fallback = await findExperts(engine, opts);
          expect(fallback.map(r => r.slug)).toEqual([expertSlug]);
          expect(fallback[0].factors.salience).toBe(0.5);
          expect(fallback[0].factors.salience_factor).toBe(0.75);
          expect(fallback[0].score).toBeCloseTo(fallback[0].factors.expertise * fallback[0].factors.recency_factor * 0.75, 12);
        } finally { engine.getSalienceScores = readScores; }
      });

      test(`${caller} experts propagate required admission SQL failures`, async () => {
        await seedExpert();
        expect((await findExperts(engine, opts)).map(r => r.slug)).toEqual([expertSlug]);
        const readDates = engine.getEffectiveDates.bind(engine);
        try {
          engine.getEffectiveDates = async () => {
            await engine.executeRaw('SELECT admission_missing_column FROM pages LIMIT 1');
            return new Map();
          };
          await expect(findExperts(engine, opts)).rejects.toThrow('admission_missing_column');
        } finally { engine.getEffectiveDates = readDates; }
      });
    }

    test('fixed 40-page enrichment batch uses one query and has an executable real-engine plan', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 40; i++) ids.push(await page(`notes/batch-${i}`));
      for (let i = 1; i < ids.length; i++) await edge(ids[i], ids[0]);
      const statements: Array<{ sql: string; params?: unknown[] }> = [];
      const query: ReadQuery = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        statements.push({ sql, params });
        return engine.executeRaw<T>(sql, params);
      };
      const start = performance.now();
      const counts = await readBacklinkCounts(query, ids, policy);
      const elapsedMs = performance.now() - start;
      expect(statements).toHaveLength(1);
      expect(counts.get(ids[0])).toBe(39);
      expect(counts.size).toBe(40);
      const plan = await engine.executeRaw<Record<string, unknown>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statements[0].sql}`, statements[0].params);
      expect(plan).toHaveLength(1);
      expect(JSON.stringify(plan)).toContain('Actual Rows');
      // Diagnostic evidence, not a host-speed assertion. The query-count guard
      // is stable under CI load; an arbitrary latency threshold would not be.
      console.info(`[read-enrichment] ${kind} pages=40 links=39 queries=1 elapsed_ms=${elapsedMs.toFixed(2)} explain_analyze=ok`);
    });
  });
}
