/**
 * #6281: an alias-resolving snapshot read never scans every page.
 *
 * Protects: `readPageSnapshot` with `resolveAlias` (get_page's alias hit and miss, fetch's `requireUnambiguous`
 * exact hit), scoped to the caller's readable sources as every caller scopes it, visits only a handful of `pages` rows
 * on a brain with thousands of pages, measured from
 * EXPLAIN (ANALYZE, FORMAT JSON) of each statement it sends, on PGLite and Postgres; and the alias semantics hold
 * (exact outranks alias, source preference, ambiguity across sources, preserveExactIdentity, deleted target,
 * archived alias source, includeDeleted). Regression it catches: `slug=$1 OR EXISTS(alias)`, which reads every page.
 * No wall-clock thresholds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readPageSnapshot } from '../src/core/page-state/snapshot.ts';
import { PageSnapshotAmbiguousError } from '../src/core/page-state/types.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const FILLER = 12_000;

type PlanNode = { 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] };
function pagesVisited(node: PlanNode): number {
  const own = node['Relation Name'] === 'pages'
    ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * (node['Actual Loops'] ?? 1) : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + pagesVisited(child), 0);
}

for (const kind of testBackends()) {
  describe(`alias snapshot reads use the indexes (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('alt','alt'),('gone','gone') ON CONFLICT (id) DO NOTHING");
      for (const source of ['default', 'alt']) {
        await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
          SELECT $1, 'filler/p-' || g, 'note', 'Filler ' || g, 'filler body' FROM generate_series(1, $2::int) g`, [source, FILLER / 2]);
      }
      const put = (slug: string, sourceId: string, frontmatter: Record<string, unknown> = {}) =>
        engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, frontmatter }, { sourceId });
      await put('people/alice-example', 'default');
      await put('people/alice-example', 'alt');
      await put('people/bob-example', 'default');
      await put('people/ann-example', 'default');
      await put('people/private-example', 'default', { visibility: 'private' });
      await put('people/carol-example', 'default');
      await put('people/carol-example', 'gone');
      await engine.executeRaw(`INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES
        ('default','bob','people/bob-example'),
        ('default','alice','people/alice-example'),('alt','alice','people/alice-example'),
        ('default','people/ann-example','people/bob-example'),
        ('default','people/private-example','people/carol-example'),
        ('gone','carol','people/carol-example')`);
      await engine.executeRaw("UPDATE sources SET archived=true WHERE id='gone'");
      await engine.executeRaw('ANALYZE pages');
      await engine.executeRaw('ANALYZE slug_aliases');
    }, 180_000);
    afterAll(async () => { await close?.(); });

    async function visits(slug: string, opts: Parameters<typeof readPageSnapshot>[2]) {
      const counts: number[] = [];
      const query = async <T,>(sql: string, params?: unknown[]): Promise<T[]> => {
        if (sql.trimStart().startsWith('WITH chosen')) {
          const [plan] = await engine.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
          const parsed = (typeof plan!['QUERY PLAN'] === 'string' ? JSON.parse(plan!['QUERY PLAN'] as string) : plan!['QUERY PLAN']) as Array<{ Plan: PlanNode }>;
          counts.push(pagesVisited(parsed[0]!.Plan));
        }
        return engine.executeRaw<T>(sql, params);
      };
      const snapshot = await readPageSnapshot(query as Parameters<typeof readPageSnapshot>[0], slug, opts).catch((error: unknown) => error);
      return { counts, snapshot };
    }

    test.each([
      ['get_page alias hit', 'bob', { resolveAlias: true, sourceIds: ['default', 'alt'] }],
      ['get_page alias hit in one source', 'bob', { resolveAlias: true, sourceId: 'default' }],
      ['get_page miss', 'nobody-example', { resolveAlias: true, sourceIds: ['default', 'alt'] }],
      ['fetch exact hit across sources', 'people/bob-example', { resolveAlias: true, requireUnambiguous: true, sourceIds: ['default', 'alt'] }],
      ['fetch exact hit in one source', 'people/bob-example', { resolveAlias: true, requireUnambiguous: true, sourceId: 'default' }],
      ['private exact with preserveExactIdentity', 'people/private-example', { resolveAlias: true, excludePrivate: true, preserveExactIdentity: true, sourceIds: ['default', 'alt'] }],
    ] as const)('%s visits fewer than 100 pages rows per statement', async (_name, slug, opts) => {
      const { counts } = await visits(slug, opts);
      expect(counts.length).toBeGreaterThan(0);
      for (const count of counts) expect(count).toBeLessThan(100);
    });

    test('semantics: exact outranks alias, alias resolves, source preference, ambiguity, preserveExactIdentity, archived alias source', async () => {
      const read = (slug: string, opts: Parameters<typeof readPageSnapshot>[2]) => readPageSnapshot((sql, params) => engine.executeRaw(sql, params), slug, opts);
      expect((await read('people/ann-example', { resolveAlias: true }))?.page.slug).toBe('people/ann-example');
      expect((await read('bob', { resolveAlias: true }))?.page.slug).toBe('people/bob-example');
      expect((await read('alice', { resolveAlias: true, sourceIds: ['alt', 'default'] }))?.page.source_id).toBe('alt');
      expect((await read('alice', { resolveAlias: true }))?.page.source_id).toBe('default');
      await expect(read('alice', { resolveAlias: true, requireUnambiguous: true })).rejects.toBeInstanceOf(PageSnapshotAmbiguousError);
      expect((await read('people/bob-example', { resolveAlias: true, requireUnambiguous: true, sourceId: 'default' }))?.page.slug).toBe('people/bob-example');
      expect(await read('people/private-example', { resolveAlias: true, excludePrivate: true, preserveExactIdentity: true })).toBeNull();
      expect((await read('people/private-example', { resolveAlias: true, excludePrivate: true }))?.page.slug).toBe('people/carol-example');
      expect(await read('carol', { resolveAlias: true })).toBeNull();
      expect((await read('carol', { resolveAlias: true, includeDeleted: true }))?.page.source_id).toBe('gone');
      expect(await read('nobody-example', { resolveAlias: true })).toBeNull();
      await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE slug='people/bob-example' AND source_id='default'");
      try {
        expect(await read('bob', { resolveAlias: true })).toBeNull();
        expect((await read('bob', { resolveAlias: true, includeDeleted: true }))?.page.slug).toBe('people/bob-example');
      } finally { await engine.executeRaw("UPDATE pages SET deleted_at=NULL WHERE slug='people/bob-example' AND source_id='default'"); }
    });
  });
}
