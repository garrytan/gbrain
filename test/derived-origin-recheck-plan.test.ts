/**
 * GST-2689 follow-up: the derived-origin recheck inside a purge's delete transaction reads only the pages that can
 * name the purged pages, not every page of the source.
 *
 * Protects: `parkUncarriedInPurge` (the single-page purge and the bulk delete call it in their transaction) sends one
 * dependents statement (private-labels.ts `dependentsSql('remove')`) that visits a handful of `pages` rows on a source of
 * thousands, measured from EXPLAIN (ANALYZE, FORMAT JSON) on PGLite and Postgres; and the statement still returns every
 * tie the full scan found: a derived_from string with `.md`, a derived_from array with and without `.md`, an atom's
 * source_slug, an atom whose source_slug a rename (slug_aliases, slug_rename_history) moved to the origin, a concept
 * through its provenance atom, a life-chronicle event's own derived_from and an event whose event.depth page derives
 * from the origin (including a slug that reads as a number, and a dated slug such as `2026-11`, which is never cast
 * as one), and never an event that fails closed on a removed event.depth page or a page already private.
 * Regression it catches: a dependents statement that lists the references of every page of the source, so the purge's
 * transaction grows with the brain. No wall-clock thresholds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parkUncarriedInPurge } from '../src/core/repair/origin-carry.ts';
import { dependentsSql } from '../src/core/repair/private-labels.ts';
import { readHonorAliases, withoutCallerAccess } from '../src/core/search/private-visibility.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'source-a';
const FILLER = 12_000;

type PlanNode = { 'Relation Name'?: string; 'Subplan Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] };
/**
 * The pages rows the statement's own joins and CTEs visit. The correlated subqueries of the privacy rules
 * (private-visibility.ts, `SubPlan`/`InitPlan` nodes) are left out: they judge each candidate the same way every read does.
 */
function pagesVisited(node: PlanNode): number {
  if (/^(SubPlan|InitPlan)/.test(node['Subplan Name'] ?? '')) return 0;
  const own = node['Relation Name'] === 'pages'
    ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * (node['Actual Loops'] ?? 1) : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + pagesVisited(child), 0);
}

/** Every page a removal of `o/origin` (and `o/second`, removed with it) opens, then the pages it must never return. */
const OPENED = ['o/digest-md', 'o/digest-array', 'o/digest-array-md', 'o/atom', 'o/atom-aliased', 'o/atom-moved', 'o/concept', 'o/event', 'o/depth', 'o/event-via-depth', 'o/twelve', 'o/dated'];
const KEPT = ['o/own', 'o/closed', 'o/plain'];
const PAGES: Record<string, string[]> = {
  'o/origin': ['type: note', 'visibility: private'],
  '12': ['type: note', 'visibility: private'],
  '2026-11': ['type: note', 'visibility: private'],
  'o/digest-md': ['type: note', 'derived_from: o/origin.md'],
  'o/digest-array': ['type: note', 'derived_from: [o/origin]'],
  'o/digest-array-md': ['type: note', 'derived_from: [o/plain, o/origin.md]'],
  'o/atom': ['type: atom', 'visibility: world', 'source_slug: o/origin'],
  'o/atom-aliased': ['type: atom', 'visibility: world', 'source_slug: o/old-name'],
  'o/atom-moved': ['type: atom', 'visibility: world', 'source_slug: o/older-name'],
  'o/concept': ['type: concept', 'synthesized_by: test', 'visibility: world'],
  'o/event': ['type: event', 'captured_via: life-chronicle:auto', 'visibility: world', 'derived_from: [o/origin.md]', 'event:', '  depth: o/plain'],
  'o/depth': ['type: meeting', 'derived_from: [o/origin]'],
  'o/event-via-depth': ['type: event', 'captured_via: life-chronicle:auto', 'visibility: world', 'event:', '  depth: o/depth'],
  'o/twelve': ['type: note', 'derived_from: [12]'],
  'o/dated': ['type: note', "derived_from: ['2026-11']"],
  'o/own': ['type: note', 'visibility: private', 'derived_from: [o/origin]'],
  'o/closed': ['type: event', 'captured_via: life-chronicle:auto', 'visibility: world', 'event:', '  depth: o/origin'],
  'o/plain': ['type: note'],
};

for (const kind of testBackends()) {
  describe(`the in-purge derived-origin recheck reads by index (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const ids: Record<string, number> = {};
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter)
        SELECT $1, 'filler/p-' || g, 'note', 'Filler ' || g, 'filler body',
          CASE g % 4 WHEN 0 THEN jsonb_build_object('derived_from', jsonb_build_array('filler/p-' || (g + 1)))
            WHEN 1 THEN jsonb_build_object('source_slug', 'filler/p-' || (g + 1)) ELSE '{}'::jsonb END
        FROM generate_series(1, $2::int) g`, [SRC, FILLER]);
      for (const [slug, fm] of Object.entries(PAGES)) {
        const text = ['---', `title: ${slug}`, ...fm, '---', `# ${slug}`, '', 'Body.'].join('\n');
        expect((await importFromContent(engine, slug, text, { sourceId: SRC, noEmbed: true })).status).toBe('imported');
      }
      for (const row of await engine.executeRaw<{ id: number; slug: string }>("SELECT id, slug FROM pages WHERE source_id=$1 AND slug NOT LIKE 'filler/%'", [SRC])) ids[row.slug] = Number(row.id);
      await engine.executeRaw("INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes) VALUES ($1, 'o/old-name', 'o/origin', 'rename')", [SRC]);
      await engine.executeRaw("INSERT INTO slug_rename_history (source_id, old_slug, new_slug) VALUES ($1, 'o/older-name', 'o/origin')", [SRC]);
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'synthesized_from', 'concept-provenance')`, [ids['o/concept'], ids['o/atom']]);
      await engine.executeRaw('ANALYZE pages');
    }, 240_000);
    afterAll(async () => { await close?.(); });

    test('the removal of the origins returns every page it opens and none it keeps', async () => {
      const origins = ['o/origin', '12', '2026-11'];
      const rows = await withoutCallerAccess(async () => {
        await readHonorAliases(engine);
        return engine.executeRaw<{ id: number; cleared_id: number }>(dependentsSql('remove'),
          [origins.map(slug => ids[slug]), origins.map(() => SRC), origins, origins.map(() => '')], { jitOff: true });
      });
      const bySlug = Object.fromEntries(Object.entries(ids).map(([slug, id]) => [id, slug]));
      expect([...new Set(rows.map(row => bySlug[Number(row.id)]))].sort()).toEqual([...OPENED].sort());
      for (const slug of KEPT) expect(rows.some(row => bySlug[Number(row.id)] === slug)).toBe(false);
    });

    test('the recheck inside the delete transaction visits a handful of pages rows', async () => {
      const visits: number[] = [];
      await engine.transaction(async tx => {
        const measured = new Proxy(tx, { get(target, key) {
          if (key === 'executeRaw') return async (sql: string, params?: unknown[], opts?: unknown) => {
            if (sql.includes('cleared AS MATERIALIZED')) {
              const [plan] = await target.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params, opts as never);
              const parsed = (typeof plan!['QUERY PLAN'] === 'string' ? JSON.parse(plan!['QUERY PLAN'] as string) : plan!['QUERY PLAN']) as Array<{ Plan: PlanNode }>;
              visits.push(pagesVisited(parsed[0]!.Plan));
            }
            return target.executeRaw(sql, params, opts as never);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const parks = await parkUncarriedInPurge(measured, [ids['o/origin']!], { recheckParked: true });
        expect(parks.map(park => park.slug)).toEqual(['o/origin']);
        throw new RollbackForTest();
      }).catch(error => { if (!(error instanceof RollbackForTest)) throw error; });
      expect(visits).toHaveLength(1);
      expect(visits[0]).toBeLessThan(200);
    });
  });
}

class RollbackForTest extends Error {}
