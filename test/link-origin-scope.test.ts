/**
 * Link reads keep an edge only while the page that authored it (its origin)
 * is readable to the caller.
 *
 * 1. Protects: an edge whose origin page is soft-deleted never surfaces from
 *    get_links / get_backlinks / traverse_graph / the entity card (any arm),
 *    and for a caller with a source grant an edge whose origin page lies
 *    outside the grant never surfaces either (no context, no origin_field,
 *    no count); list_link_sources counts only edges with both endpoints and
 *    the origin inside the grant; find_orphans for a remote caller counts
 *    only inbound links from inside the grant, while the local scoped scan
 *    keeps counting inbound links from every source.
 * 2. Fails when: a read arm joins the origin page only to null its slug, or
 *    skips the origin's deleted_at, or list_link_sources scopes only the from
 *    page, or the remote orphan scan counts ungranted referrers.
 * 3. Existing coverage: test/entity-card-private-backlinks.test.ts (private
 *    origins), test/federated-link-reads-5827.test.ts (endpoint scoping).
 * 4. Fixture: no writer creates these edges, so they are inserted with SQL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type AuthInfo, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { GraphNode, GraphPath, Link } from '../src/core/types.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const A = 'source-a';
const B = 'source-b';
const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';
const ORPHAN = 'topics/orphan-target-example';
const HIDDEN = ['CTX-FOREIGN-ORIGIN', 'CTX-RETIRED-ORIGIN', 'key_people', 'notes/bob-example', 'notes/retired-example'];

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const auth = { token: '', clientId: 'client-a', scopes: ['read'], sourceId: A, allowedSources: [A], principal: { kind: 'oauth_client', id: 'client-a' } } as AuthInfo;
const contexts = (rows: Array<Link | GraphPath>) => rows.map(r => r.context).sort();

for (const kind of testBackends()) {
  describe(`link origin scope (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const remoteCtx = () => ({ engine, config: {} as never, logger: quiet, dryRun: false, remote: true, sourceId: A, auth, transport: 'http' }) as unknown as OperationContext;
    const remoteOp = (name: string, params: Record<string, unknown>) => operationsByName[name].handler(remoteCtx(), params);
    const remoteDispatch = async (name: string, params: Record<string, unknown>) => {
      const result = await dispatchToolCall(engine, name, params, { remote: true, transport: 'http', sourceId: A, auth, config: {} as never });
      expect(result.isError).toBeFalsy();
      return result.content[0].text;
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb), ($2, $2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`, [A, B]);
      const pages: Array<[string, string, string]> = [
        [A, ALICE, 'person'], [A, ACME, 'company'], [A, 'notes/live-origin-example', 'note'], [A, 'notes/retired-example', 'note'], [A, ORPHAN, 'note'],
        [B, 'notes/bob-example', 'note'], [B, 'companies/beta-example', 'company'],
      ];
      for (const [sourceId, slug, type] of pages) {
        await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter: {} }, { sourceId });
      }
      const edges: Array<[string, string, string, string, string, string, string, [string, string] | null, string | null]> = [
        [A, ALICE, A, ACME, 'references', 'foreign-origin', 'CTX-FOREIGN-ORIGIN', [B, 'notes/bob-example'], 'key_people'],
        [A, ALICE, A, ACME, 'cites', 'retired-origin', 'CTX-RETIRED-ORIGIN', [A, 'notes/retired-example'], 'related'],
        [A, ALICE, A, ACME, 'related', 'markdown', 'CTX-NO-ORIGIN', null, null],
        [A, ALICE, A, ACME, 'supports', 'frontmatter', 'CTX-LIVE-ORIGIN', [A, 'notes/live-origin-example'], 'related'],
        [A, ALICE, B, 'companies/beta-example', 'related', 'outbound-b', 'CTX-OUTBOUND', null, null],
        [B, 'notes/bob-example', A, ORPHAN, 'related', 'markdown', 'CTX-INBOUND-B', null, null],
      ];
      for (const [fs, from, ts, to, type, linkSource, context, origin, field] of edges) {
        await engine.executeRaw(
          `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
           SELECT f.id, t.id, $5, $6, $7, (SELECT o.id FROM pages o WHERE o.source_id = $8 AND o.slug = $9), $10
             FROM pages f JOIN pages t ON t.source_id = $3 AND t.slug = $4
            WHERE f.source_id = $1 AND f.slug = $2`,
          [fs, from, ts, to, type, context, linkSource, origin?.[0] ?? null, origin?.[1] ?? null, field],
        );
      }
      await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE source_id = $1 AND slug = 'notes/retired-example'`, [A]);
    }, 120_000);

    afterAll(async () => { await close?.(); });

    test('get_links and get_backlinks drop edges whose origin is outside the grant or deleted (remote, grant [source-a])', async () => {
      const out = await remoteOp('get_links', { slug: ALICE }) as Link[];
      const into = await remoteOp('get_backlinks', { slug: ACME }) as Link[];
      expect(contexts(out)).toEqual(['CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN']);
      expect(contexts(into)).toEqual(['CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN']);
      for (const marker of HIDDEN) expect(JSON.stringify([out, into])).not.toContain(marker);
    }, 60_000);

    test('getLinks and getBacklinks arms: the grant arm scopes the origin, every arm drops a deleted origin', async () => {
      expect(contexts(await engine.getLinks(ALICE, { sourceIds: [A] }))).toEqual(['CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN']);
      expect(contexts(await engine.getBacklinks(ACME, { sourceIds: [A] }))).toEqual(['CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN']);
      const local = ['CTX-FOREIGN-ORIGIN', 'CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN'];
      expect(contexts(await engine.getLinks(ALICE, { sourceId: A }))).toEqual([...local, 'CTX-OUTBOUND']);
      expect(contexts(await engine.getLinks(ALICE))).toEqual([...local, 'CTX-OUTBOUND']);
      expect(contexts(await engine.getBacklinks(ACME, { sourceId: A }))).toEqual(local);
      expect(contexts(await engine.getBacklinks(ACME))).toEqual(local);
      const foreign = (await engine.getLinks(ALICE)).find(l => l.context === 'CTX-FOREIGN-ORIGIN');
      expect(foreign).toMatchObject({ origin_slug: 'notes/bob-example', origin_source_id: B, origin_field: 'key_people' });
    }, 60_000);

    test('traverse_graph drops edges whose origin is outside the grant or deleted (remote and engine arms)', async () => {
      const paths = await remoteOp('traverse_graph', { slug: ALICE, depth: 1, direction: 'out' }) as GraphPath[];
      expect(contexts(paths)).toEqual(['CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN']);
      const detailed = async (scope: { sourceId?: string; sourceIds?: string[] }) =>
        contexts((await engine.traversePathsDetailed(ALICE, { depth: 1, direction: 'out', ...scope })).paths);
      expect(await detailed({ sourceIds: [A] })).toEqual(['CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN']);
      expect(await detailed({ sourceId: A })).toEqual(['CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN']);
      expect(await detailed({})).toEqual(['CTX-FOREIGN-ORIGIN', 'CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN', 'CTX-OUTBOUND']);
      const types = (nodes: GraphNode[]) => nodes.find(n => n.slug === ALICE)!.links.filter(l => l.to_slug === ACME).map(l => l.link_type).sort();
      expect(types(await engine.traverseGraph(ALICE, 1, { sourceIds: [A] }))).toEqual(['related', 'supports']);
      expect(types(await engine.traverseGraph(ALICE, 1))).toEqual(['references', 'related', 'supports']);
    }, 60_000);

    test('list_link_sources counts only edges with both endpoints and the origin inside the grant', async () => {
      const names = (rows: Array<{ link_source: string | null }>) => rows.map(r => r.link_source).sort();
      expect(names(await remoteOp('list_link_sources', {}) as Array<{ link_source: string }>)).toEqual(['frontmatter', 'markdown']);
      expect(names(await engine.listLinkSources({ sourceIds: [A] }))).toEqual(['frontmatter', 'markdown']);
      expect(names(await engine.listLinkSources({ sourceId: A }))).toEqual(['frontmatter', 'markdown']);
      expect(names(await engine.listLinkSources())).toEqual(['foreign-origin', 'frontmatter', 'markdown', 'outbound-b', 'retired-origin']);
    }, 60_000);

    test('find_orphans counts inbound links from inside the grant for a remote caller; the local scoped scan stays global', async () => {
      const remote = await remoteOp('find_orphans', { mode: 'inbound' }) as { orphans: Array<{ slug: string }> };
      expect(remote.orphans.map(o => o.slug)).toContain(ORPHAN);
      expect((await engine.findOrphanPages({ sourceId: A, mode: 'inbound' })).map(r => r.slug)).not.toContain(ORPHAN);
      expect((await engine.findOrphanPages({ sourceIds: [A], mode: 'inbound' })).map(r => r.slug)).not.toContain(ORPHAN);
      expect((await engine.findOrphanPages({ sourceIds: [A], mode: 'inbound', scopeInbound: true })).map(r => r.slug)).toContain(ORPHAN);
      expect((await engine.findOrphanPages({ sourceId: A, mode: 'inbound', scopeInbound: true })).map(r => r.slug)).toContain(ORPHAN);
    }, 60_000);

    test('entity card and context_pack drop edges whose origin is outside the grant or deleted (remote)', async () => {
      const result = JSON.parse(await remoteDispatch('entity', { name: ACME })) as { found: boolean; card: { edges: Array<{ direction: string; context: string | null }>; backlink_count: number } };
      expect(result.found).toBe(true);
      expect(result.card.edges.filter(e => e.direction === 'in').map(e => e.context).sort()).toEqual(['CTX-LIVE-ORIGIN', 'CTX-NO-ORIGIN']);
      expect(result.card.backlink_count).toBe(2);
      const pack = await remoteDispatch('context_pack', { entities: `${ACME},${ALICE}` });
      expect(pack).toContain('CTX-NO-ORIGIN');
      for (const marker of HIDDEN) expect(pack).not.toContain(marker);
    }, 60_000);

    test('find_orphans ignores, for a remote caller, outbound links leaving the grant and links authored outside it', async () => {
      const ISLAND = 'topics/island-out-example';
      const FOREIGN_AUTHORED = 'topics/foreign-authored-example';
      for (const slug of [ISLAND, FOREIGN_AUTHORED]) {
        await engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter: {} }, { sourceId: A });
      }
      const link = (from: [string, string], to: [string, string], origin: [string, string] | null) => engine.executeRaw(
        `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id)
         SELECT f.id, t.id, 'related', 'CTX-ORPHAN-PROBE', 'markdown', (SELECT o.id FROM pages o WHERE o.source_id = $5 AND o.slug = $6)
           FROM pages f JOIN pages t ON t.source_id = $3 AND t.slug = $4
          WHERE f.source_id = $1 AND f.slug = $2`,
        [from[0], from[1], to[0], to[1], origin?.[0] ?? null, origin?.[1] ?? null]);
      await link([A, ISLAND], [B, 'companies/beta-example'], null);
      await link([A, 'notes/live-origin-example'], [A, FOREIGN_AUTHORED], [B, 'notes/bob-example']);
      const remote = async (mode: string) => ((await remoteOp('find_orphans', { mode })) as { orphans: Array<{ slug: string }> }).orphans.map(o => o.slug);
      expect(await remote('islanded')).toContain(ISLAND);
      expect(await remote('inbound')).toContain(FOREIGN_AUTHORED);
      expect((await engine.findOrphanPages({ sourceId: A })).map(r => r.slug)).not.toContain(ISLAND);
      expect((await engine.findOrphanPages({ sourceId: A, mode: 'inbound' })).map(r => r.slug)).not.toContain(FOREIGN_AUTHORED);
    }, 60_000);
  });
}
