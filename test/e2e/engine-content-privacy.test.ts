import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { listEntityIdentities, linkEntityIdentity, unionLinksAcrossIdentity } from '../../src/core/entity-identity.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { runGather } from '../../src/core/think/gather.ts';
import { runThink } from '../../src/core/think/index.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';

const SOURCES = ['privacy-engine-a', 'privacy-engine-b', 'privacy-engine-c'];
const [A, B, C] = SOURCES;
const PRIVATE = 'PRIVATE_CONTENT_CANARY';

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: concrete content and graph privacy`, () => {
    let engine: BrainEngine;

    beforeAll(async () => {
      if (kind === 'postgres') {
        assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
        engine = new PostgresEngine();
        await engine.connect({ database_url: process.env.DATABASE_URL! });
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
      }
      await engine.initSchema();
      for (const source of SOURCES) {
        await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
      }
    }, 120_000);

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages WHERE source_id = ANY($1::text[])', [SOURCES]);
      await engine.executeRaw('DELETE FROM slug_aliases WHERE source_id = ANY($1::text[])', [SOURCES]);
      await engine.unsetConfig('entity_identity.union');
    });

    afterAll(async () => {
      if (engine) {
        await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [SOURCES]);
        await engine.unsetConfig('entity_identity.union');
        await engine.disconnect();
      }
    }, 60_000);

    async function page(slug: string, source = A, hidden = false): Promise<number> {
      const body = hidden ? PRIVATE : `public ${slug} ${source}`;
      const imported = await importFromContent(engine, slug, serializeMarkdown(
        { visibility: hidden ? 'private' : 'world' }, body, '',
        { type: 'person', title: hidden ? `${PRIVATE} ${slug}` : slug, tags: [] },
      ), { sourceId: source, noEmbed: true, forceRechunk: true });
      expect(imported.status, imported.error).toBe('imported');
      const rows = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, source]);
      const id = Number(rows[0].id);
      await engine.executeRaw("INSERT INTO raw_data (page_id, source, data) VALUES ($1, 'fixture', $2::text::jsonb)", [id, JSON.stringify({ body })]);
      await engine.executeRaw("INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-08-01', $2)", [id, body]);
      return id;
    }

    async function edge(from: number, to: number, context = 'public edge', origin: number | null = null) {
      await engine.executeRaw("INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id) VALUES ($1, $2, 'knows', $3, 'manual', $4)", [from, to, context, origin]);
    }

    async function chronicleFixture() {
      const depth = await page('people/chronicle-subject');
      const privateDepth = await page('people/chronicle-subject', B, true);
      const publicEvent = await page('events/chronicle-public');
      const depthEvent = await page('events/chronicle-private-depth');
      const privateEvent = await page('events/chronicle-collision', B, true);
      await page('events/chronicle-collision', A);
      const foreignPrivateEvent = await page('events/chronicle-foreign-private', C, true);
      await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id IN (SELECT id FROM pages WHERE source_id = ANY($1::text[]))', [SOURCES]);
      for (const [id, when, who] of [
        [publicEvent, '2026-08-10T12:00:00Z', ['people/chronicle-subject', 'people/public-event-only']],
        [depthEvent, '2026-08-11T20:00:00Z', ['people/chronicle-subject', 'people/private-depth-only']],
        [privateEvent, '2026-08-11T21:00:00Z', ['people/chronicle-subject', 'people/private-event-only']],
        [foreignPrivateEvent, '2026-08-11T22:00:00Z', ['people/chronicle-subject']],
      ] as const) {
        await engine.executeRaw("UPDATE pages SET type = 'event', effective_date = $2::timestamptz, frontmatter = frontmatter || $3::text::jsonb WHERE id = $1", [id, when, JSON.stringify({ event: { who, kind: 'meeting' } })]);
      }
      for (const [pageId, eventId, date, summary] of [
        [privateDepth, null, '2026-08-10', PRIVATE],
        [depth, privateEvent, '2026-08-10', PRIVATE],
        [depth, foreignPrivateEvent, '2026-08-10', PRIVATE],
        [depth, publicEvent, '2026-08-10', 'visible chronicle event'],
        [privateDepth, depthEvent, '2026-08-11', PRIVATE],
        [depth, privateEvent, '2026-08-11', PRIVATE],
        [depth, foreignPrivateEvent, '2026-08-11', PRIVATE],
      ] as const) {
        await engine.executeRaw('INSERT INTO timeline_entries (page_id, event_page_id, date, summary, source) VALUES ($1, $2, $3::date, $4, $5)', [pageId, eventId, date, summary, `fixture:event:${eventId}`]);
      }
    }

    test('same-slug private rows cannot win exact resolution or leak through content readers', async () => {
      const publicId = await page('people/shared');
      const privateId = await page('people/shared', B, true);
      const scope = { sourceIds: [B, A], excludePrivate: true };
      expect((await engine.getPage('people/shared', scope))?.id).toBe(publicId);
      expect((await engine.getPage('people/shared', { sourceIds: [B, A] }))?.id).toBe(privateId);
      expect(await engine.getPage('people/shared', { sourceId: B, excludePrivate: true })).toBeNull();
      expect((await engine.getPage('people/shared', { sourceId: A, sourceIds: [], excludePrivate: true }))?.id).toBe(publicId);
      for (const rows of [
        await engine.getChunks('people/shared', scope),
        await engine.getRawData('people/shared', undefined, scope),
        await engine.getRawData('people/shared', 'fixture', scope),
        await engine.getTimeline('people/shared', { ...scope, limit: 1 }),
      ]) {
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows)).not.toContain(PRIVATE);
      }
      expect(JSON.stringify(await engine.getRawData('people/shared'))).toContain(PRIVATE);
      expect(await engine.getChunks('people/shared', { sourceId: B, excludePrivate: true })).toEqual([]);
      await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [privateId]);
      expect(await engine.getPage('people/shared', { sourceId: B, includeDeleted: true, excludePrivate: true })).toBeNull();
    });

    test('fuzzy and alias resolution filter private candidates before choosing a winner', async () => {
      for (let i = 0; i < 8; i++) await page(`people/needle-secret-${i}`, A, true);
      await page('people/needle-public', A);
      expect(await engine.resolveSlugs('needle', { sourceId: A, excludePrivate: true })).toEqual(['people/needle-public']);
      expect((await engine.resolveSlugs('needle', { sourceId: A })).length).toBe(5);
      await page('people/canonical-secret', B, true);
      await page('people/canonical-public', A);
      for (const [source, canonical] of [[B, 'people/canonical-secret'], [A, 'people/canonical-public']]) {
        await engine.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)', [source, 'people/alias', canonical]);
      }
      expect(await engine.resolveSlugWithAliasDetailed('people/alias', [B, A], { excludePrivate: true })).toEqual({ canonical_slug: 'people/canonical-public', source_id: A });
      expect(await engine.resolveSlugWithAlias('people/alias', [B, A])).toBe('people/canonical-secret');
    });

    test('history requires both a visible current page and a visible historical snapshot', async () => {
      const visible = await page('people/history');
      const hidden = await page('people/history', B, true);
      for (const [id, visibility, body] of [[visible, 'world', 'public history'], [visible, 'private', PRIVATE], [hidden, 'world', PRIVATE], [hidden, 'private', PRIVATE]] as const) {
        await engine.executeRaw('INSERT INTO page_versions (page_id, compiled_truth, frontmatter) VALUES ($1, $2, $3::text::jsonb)', [id, body, JSON.stringify({ visibility })]);
      }
      const history = await engine.getVersions('people/history', { sourceIds: [A, B], excludePrivate: true });
      expect(history).toHaveLength(1);
      expect(history[0].compiled_truth).toBe('public history');
      expect(await engine.getVersions('people/history', { sourceId: B, excludePrivate: true })).toEqual([]);
      expect(await engine.getVersions('people/history', { sourceIds: [A, B], excludePrivate: false })).toHaveLength(4);
      expect(JSON.stringify(await engine.getVersions('people/history'))).toContain(PRIVATE);
    });

    test('get_page protects every body field when trust is unset, independently of holder grants and page opt-outs', async () => {
      const body = `${renderFactsTable([
        { rowNum: 1, claim: 'PUBLIC_BODY_FACT', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
        { rowNum: 2, claim: PRIVATE, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
      ])}\n${TAKES_FENCE_BEGIN}\nPRIVATE_BODY_TAKE\n${TAKES_FENCE_END}`;
      await engine.putPage('people/body-default', {
        type: 'person', title: 'Public body fixture', compiled_truth: body, timeline: body,
        frontmatter: { visibility: 'world' },
      }, { sourceId: A });
      try {
        for (const allowPrivatePages of [false, true]) {
          if (allowPrivatePages) await engine.setConfig('search.remote_private_pages', 'visible');
          else await engine.unsetConfig('search.remote_private_pages');
          __resetPrivateVisibilityCacheForTests();
          for (const remote of [undefined, true, false]) {
            const ctx = { engine, sourceId: A, remote, takesHoldersAllowList: ['world', 'owner-example'] } as OperationContext;
            const result = await operationsByName.get_page.handler(ctx, { slug: 'people/body-default', include_content: true }) as Record<string, string>;
            for (const field of ['compiled_truth', 'timeline', 'content']) {
              expect(result[field]).toContain('PUBLIC_BODY_FACT');
              if (remote === false) {
                expect(result[field]).toContain(PRIVATE);
                expect(result[field]).toContain('PRIVATE_BODY_TAKE');
              } else {
                expect(result[field]).not.toContain(PRIVATE);
                expect(result[field]).not.toContain('PRIVATE_BODY_TAKE');
              }
            }
          }
        }
      } finally {
        await engine.unsetConfig('search.remote_private_pages');
        __resetPrivateVisibilityCacheForTests();
      }
    });

    test('private event projections are excluded before the timeline limit', async () => {
      const depth = await page('people/timeline');
      for (let i = 0; i < 5; i++) {
        const event = await page(`events/private-${i}`, B, true);
        await engine.executeRaw(
          'INSERT INTO timeline_entries (page_id, date, summary, event_page_id) VALUES ($1, $2::date, $3, $4)',
          [depth, `2026-08-${String(20 + i).padStart(2, '0')}`, PRIVATE, event],
        );
      }
      const rows = await engine.getTimeline('people/timeline', { sourceId: A, excludePrivate: true, limit: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toBe('public people/timeline privacy-engine-a');
      expect(JSON.stringify(await engine.getTimeline('people/timeline', { sourceId: A, limit: 1 }))).toContain(PRIVATE);
    });

    test('Chronicle filters private depth and event pages before limits and last-seen selection', async () => {
      await chronicleFixture();
      const scope = { sourceId: C, sourceIds: [A, B], excludePrivate: true, limit: 1 };
      for (const rows of [
        await engine.getTimelineForDate('2026-08-10', scope),
        await engine.getTimelineForDate('2026-08-10', { ...scope, week: true }),
        await engine.getSince('2026-08-10', scope),
        await engine.getSince('2026-08-10', { ...scope, kind: 'meeting' }),
        await engine.getOnThisDay({ ...scope, date: '2027-08-10' }),
        await engine.getSince('2026-08-10', { sourceId: A, sourceIds: [], excludePrivate: true, limit: 1 }),
      ]) {
        expect(rows.map(r => r.summary)).toEqual(['visible chronicle event']);
        expect(JSON.stringify(rows)).not.toContain(PRIVATE);
      }
      expect(await engine.getLastSeen('people/chronicle-subject', { ...scope, asof: '2026-08-12' })).toEqual({
        entity_slug: 'people/chronicle-subject', last_date: '2026-08-10', last_event_slug: 'events/chronicle-public', days_ago: 2,
      });
      expect((await engine.getLastSeen('people/public-event-only', { ...scope, asof: '2026-08-12' })).last_date).toBe('2026-08-10');
      for (const entity of ['people/private-depth-only', 'people/private-event-only']) {
        expect((await engine.getLastSeen(entity, { ...scope, asof: '2026-08-12' })).last_date).toBeNull();
      }
      expect(JSON.stringify(await engine.getSince('2026-08-10', { sourceIds: [A, B] }))).toContain(PRIVATE);
      expect((await engine.getLastSeen('people/chronicle-subject', { sourceIds: [A, B], asof: '2026-08-12' })).last_date).toBe('2026-08-11');
    });

    test('Chronicle operations propagate remote privacy through timeline and volunteer reads', async () => {
      await chronicleFixture();
      for (const remote of [true, undefined]) {
        const ctx = { engine, remote, sourceId: A, auth: { allowedSources: [A, B] } } as OperationContext;
        for (const [op, args] of [
          ['chronicle_day', { date: '2026-08-10', limit: 1, narrative: true }],
          ['chronicle_since', { date: '2026-08-10', limit: 1 }],
          ['chronicle_on_this_day', { date: '2027-08-10', limit: 1 }],
          ['volunteer_chronicle', { days: 36500, limit: 1 }],
        ] as const) {
          const result = await operationsByName[op].handler(ctx, args);
          expect(JSON.stringify(result)).toContain('visible chronicle event');
          expect(JSON.stringify(result)).not.toContain(PRIVATE);
        }
        const seen = await operationsByName.chronicle_last_seen.handler(ctx, { entity: 'people/chronicle-subject', asof: '2026-08-12' });
        expect(seen).toMatchObject({ last_date: '2026-08-10', last_event_slug: 'events/chronicle-public' });
      }
      const local = { engine, remote: false, sourceId: A } as OperationContext;
      expect(JSON.stringify(await operationsByName.chronicle_since.handler(local, { date: '2026-08-10' }))).toContain(PRIVATE);
    });

    test('takes require both a visible concrete page and an allowed holder in every read arm', async () => {
      const visible = await page('people/takes-shared');
      const hidden = await page('people/takes-shared', B, true);
      await engine.addTakesBatch([
        { page_id: visible, row_num: 1, claim: 'privacy retrieval public', kind: 'bet', holder: 'world', weight: 0.4 },
        { page_id: hidden, row_num: 1, claim: `privacy retrieval ${PRIVATE}`, kind: 'bet', holder: 'world', weight: 1 },
        { page_id: visible, row_num: 2, claim: 'privacy retrieval PRIVATE_HOLDER_CANARY', kind: 'bet', holder: 'owner-example', weight: 0.9 },
      ]);
      for (const [pageId, rowNum, quality] of [[visible, 1, 'correct'], [hidden, 1, 'incorrect'], [visible, 2, 'incorrect']] as const) {
        await engine.resolveTake(pageId, rowNum, { quality, resolvedBy: 'mcp:privacy-fixture' });
      }
      const [column] = await engine.executeRaw<{ dims: number }>("SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'takes'::regclass AND attname = 'embedding'");
      const vector = new Float32Array(Number(column.dims));
      vector[0] = 1;
      await engine.executeRaw('UPDATE takes SET embedding = $1::vector WHERE page_id = ANY($2::int[])', [`[${Array.from(vector).join(',')}]`, [visible, hidden]]);
      const scope = { sourceId: C, sourceIds: [A, B], excludePrivate: true, takesHoldersAllowList: ['world'], limit: 1 };
      for (const rows of [
        await engine.listTakes({ ...scope, sortBy: 'weight' }),
        await engine.searchTakes('privacy retrieval', scope),
        await engine.searchTakesVector(vector, scope),
      ]) {
        expect(rows.map(r => r.claim)).toEqual(['privacy retrieval public']);
      }
      expect(await engine.searchTakes('privacy retrieval', { ...scope, takesHoldersAllowList: [] })).toEqual([]);
      expect(await engine.searchTakesVector(vector, { ...scope, takesHoldersAllowList: [] })).toEqual([]);
      const gathered = await runGather(engine, { question: 'privacy retrieval', remote: true, ...scope, questionEmbedding: vector });
      expect(gathered.takes.map(r => r.claim)).toEqual(['privacy retrieval public']);
      const remote = { engine, remote: true, sourceId: A, auth: { allowedSources: [A, B] } } as OperationContext;
      for (const [op, args] of [['takes_list', {}], ['takes_search', { query: 'privacy retrieval' }]] as const) {
        expect((await operationsByName[op].handler(remote, args) as Array<{ claim: string }>).map(r => r.claim)).toEqual(['privacy retrieval public']);
      }
      expect(await engine.listTakes({ sourceIds: [A, B] })).toHaveLength(3);
      expect(await engine.getScorecard(scope, ['world'])).toMatchObject({ total_bets: 1, resolved: 1, correct: 1, incorrect: 0 });
      expect((await engine.getCalibrationCurve(scope, ['world'])).map(r => [r.n, r.observed])).toEqual([[1, 1]]);
      expect((await engine.getScorecard(scope, [])).total_bets).toBe(0);
      expect(await engine.getCalibrationCurve(scope, [])).toEqual([]);
      for (const remoteFlag of [true, undefined]) {
        // Exercise the runtime fail-closed default for legacy contexts that omit remote.
        const context = { ...remote, remote: remoteFlag } as OperationContext;
        expect(await operationsByName.takes_scorecard.handler(context, {})).toMatchObject({ total_bets: 1, mcp_resolved: 1 });
        expect((await operationsByName.takes_calibration.handler(context, {}) as Array<{ n: number }>).map(r => r.n)).toEqual([1]);
      }
      expect(await operationsByName.takes_scorecard.handler({ ...remote, takesHoldersAllowList: [] }, {})).toMatchObject({ total_bets: 0, mcp_resolved: 0 });
      expect((await engine.getScorecard({ sourceIds: [A, B] }, undefined)).total_bets).toBe(3);
      try {
        await engine.setConfig('search.remote_private_pages', 'visible');
        __resetPrivateVisibilityCacheForTests();
        const optedOut = await operationsByName.takes_search.handler(remote, { query: 'privacy retrieval' }) as Array<{ claim: string }>;
        expect(optedOut).toHaveLength(2);
        expect(JSON.stringify(optedOut)).toContain(PRIVATE);
        expect(JSON.stringify(optedOut)).not.toContain('PRIVATE_HOLDER_CANARY');
        expect(await operationsByName.takes_scorecard.handler(remote, {})).toMatchObject({ total_bets: 2, mcp_resolved: 2 });
      } finally {
        await engine.unsetConfig('search.remote_private_pages');
        __resetPrivateVisibilityCacheForTests();
      }
    });

    test('runThink resolves omitted page privacy centrally while trusted callers retain private reads', async () => {
      const hidden = await page('people/private-think', B, true);
      await engine.addTakesBatch([{ page_id: hidden, row_num: 1, claim: `privacy retrieval ${PRIVATE}`, kind: 'fact', holder: 'world', weight: 1 }]);
      const opts = {
        question: 'privacy retrieval', anchor: 'people/private-think', sourceId: B,
        stubResponse: { answer: 'Synthetic fixture answer.', citations: [], gaps: [] },
      };
      const remote = await runThink(engine, { ...opts, remote: true });
      expect(remote.pagesGathered).toBe(0);
      expect(remote.takesGathered).toBe(0);
      const local = await runThink(engine, { ...opts, remote: false });
      expect(local.pagesGathered).toBeGreaterThan(0);
      expect(local.takesGathered).toBe(1);
    });

    test('link endpoints and an independently resolved private origin are excluded', async () => {
      const root = await page('people/root');
      const visible = await page('people/visible');
      const hidden = await page('people/secret', A, true);
      const foreign = await page('people/foreign', B);
      const privateOrigin = await page('people/origin', C, true);
      const originTarget = await page('people/origin-target');
      await edge(root, visible);
      await edge(root, hidden, PRIVATE);
      await edge(root, foreign, 'cross-source public');
      await edge(root, originTarget, PRIVATE, privateOrigin);
      const scoped = await engine.getLinks('people/root', { sourceIds: [A], excludePrivate: true });
      expect(scoped.map(r => r.to_slug)).toEqual(['people/visible']);
      expect(await engine.getBacklinks('people/origin-target', { sourceIds: [A], excludePrivate: true })).toEqual([]);
      expect(await engine.getBacklinks('people/secret', { sourceId: A, excludePrivate: true })).toEqual([]);
      expect(await engine.getLinks('people/root', { sourceId: A })).toHaveLength(4);
      expect(await engine.getLinks('people/root', { sourceId: A, excludePrivate: true })).toHaveLength(2);
      expect(await engine.getBacklinks('people/visible', { sourceIds: [A], excludePrivate: true })).toHaveLength(1);
    });

    test('private graph hops and origins cannot relay paths or consume the frontier budget', async () => {
      const root = await page('people/root');
      const hidden = await page('people/a-private', A, true);
      const tail = await page('people/tail');
      const visible = await page('people/z-visible');
      const origin = await page('people/private-origin', B, true);
      const originTarget = await page('people/origin-target');
      await edge(root, hidden, PRIVATE);
      await edge(hidden, tail, PRIVATE);
      await edge(root, visible);
      await edge(root, originTarget, PRIVATE, origin);
      const scope = { sourceIds: [A], excludePrivate: true };
      const graph = await engine.traverseGraph('people/root', 3, { ...scope, frontierCap: 1 });
      expect(graph.map(r => r.slug).sort()).toEqual(['people/root', 'people/z-visible']);
      expect(graph.find(r => r.slug === 'people/root')?.links).toEqual([{ to_slug: 'people/z-visible', link_type: 'knows' }]);
      for (const direction of ['out', 'in', 'both'] as const) {
        const paths = await engine.traversePathsDetailed('people/root', { ...scope, direction, depth: 3 });
        expect(JSON.stringify(paths)).not.toContain(PRIVATE);
        expect(paths.paths.some(r => r.to_slug === 'people/tail' || r.to_slug === 'people/origin-target')).toBe(false);
        expect(paths.paths).toHaveLength(direction === 'in' ? 0 : direction === 'both' ? 2 : 1);
        expect(paths.paths.every(r => [r.from_slug, r.to_slug].every(slug => ['people/root', 'people/z-visible'].includes(slug)))).toBe(true);
      }
      expect(await engine.traverseGraph('people/a-private', 3, scope)).toEqual([]);
      expect((await engine.traversePaths('people/root', { sourceId: A, depth: 3 })).length).toBeGreaterThan(1);
    });

    test('orphans exclude private candidates and edges while preserving public cross-source reachability', async () => {
      const isolated = await page('people/private-only-link');
      const hidden = await page('people/hidden', A, true);
      const reachable = await page('people/reachable');
      const foreign = await page('people/public-referrer', B);
      await edge(isolated, hidden, PRIVATE);
      await edge(foreign, reachable);
      const rows = await engine.findOrphanPages({ sourceId: A, excludePrivate: true });
      expect(rows.map(r => r.slug)).toEqual(['people/private-only-link']);
      expect(await engine.findOrphanPages({ sourceId: A })).toEqual([]);
    });

    test('identity seed, members and member link unions share source and private boundaries', async () => {
      const seed = await page('people/seed');
      const member = await page('people/member', B);
      await page('people/private-member', B, true);
      await page('people/foreign-member', C);
      const target = await page('people/target');
      const foreignTarget = await page('people/foreign-target', C);
      const nonmember = await page('people/member', A);
      const nonmemberTarget = await page('people/nonmember-target');
      await edge(member, target);
      await edge(member, foreignTarget, 'foreign edge');
      await edge(nonmember, nonmemberTarget, 'same-slug nonmember edge');
      for (const [slug, source] of [['people/seed', A], ['people/member', B], ['people/private-member', B], ['people/foreign-member', C]]) {
        await linkEntityIdentity(engine, { entityId: 'privacy-fixture', slug, sourceId: source });
      }
      const opts = { sourceId: A, allowedSources: [A, B], excludePrivate: true };
      const members = await listEntityIdentities(engine, { slug: 'people/seed', ...opts });
      expect(members.map(r => r.slug).sort()).toEqual(['people/member', 'people/seed']);
      expect(await listEntityIdentities(engine, { slug: 'people/private-member', ...opts })).toEqual([]);
      expect(await listEntityIdentities(engine, { entityId: 'privacy-fixture', sourceId: A, allowedSources: [], excludePrivate: true })).toHaveLength(1);
      expect(await listEntityIdentities(engine, { entityId: 'privacy-fixture' })).toHaveLength(4);
      await engine.setConfig('entity_identity.union', 'true');
      const union = await unionLinksAcrossIdentity(engine, 'people/seed', [], 'out', opts);
      expect(union).toHaveLength(1);
      expect(union[0].to_slug).toBe('people/target');
      expect(await unionLinksAcrossIdentity(engine, 'people/seed', [], 'out', { sourceId: A, allowedSources: [], excludePrivate: true })).toEqual([]);
      await engine.executeRaw('UPDATE entity_identities SET source_id = $1 WHERE source_id = $2', [A, C]);
      expect((await listEntityIdentities(engine, { entityId: 'privacy-fixture', allowedSources: [A], excludePrivate: true })).map(r => r.slug)).toEqual(['people/seed']);
      expect(await listEntityIdentities(engine, { slug: 'people/foreign-member', allowedSources: [A], excludePrivate: true })).toEqual([]);
      expect(seed).toBeGreaterThan(0);
    });
  });
}
