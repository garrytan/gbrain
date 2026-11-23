/**
 * #9721: the stale-edge lookup of `replaceConceptProvenanceLinks` runs once per published concept. Its predicate ORed a
 * condition on the from page with one on the to page, so neither `pages_source_slug_key` nor the links indexes could
 * serve it and every run read all concept-provenance links and every page. It now keys both directions on the concept's
 * page id. Measured from EXPLAIN (ANALYZE, FORMAT JSON) of the statement the function sends, on PGLite and Postgres, on
 * a brain with thousands of pages and provenance links; no wall-clock thresholds. Semantics: only the edges of the atom
 * that left the member group retire, in both directions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { replaceConceptProvenanceLinks } from '../src/core/cycle/concept-publication.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const FILLER = 8_000;
const CONCEPT = 'concepts/storage-example';

type PlanNode = { 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] };
function rowsVisited(node: PlanNode, relation: string): number {
  const own = node['Relation Name'] === relation
    ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * (node['Actual Loops'] ?? 1) : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + rowsVisited(child, relation), 0);
}

for (const kind of testBackends()) {
  describe(`concept provenance stale-edge lookup uses the indexes (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
        SELECT 'default', 'filler/p-' || g, 'note', 'Filler ' || g, 'filler body' FROM generate_series(1, $1::int) g`, [FILLER]);
      await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,link_source)
        SELECT f.id, t.id, 'synthesized_from', 'concept-provenance' FROM generate_series(1, $1::int) g
          JOIN pages f ON f.source_id = 'default' AND f.slug = 'filler/p-' || g
          JOIN pages t ON t.source_id = 'default' AND t.slug = 'filler/p-' || (g + 1)`, [FILLER - 1]);
      await engine.putPage(CONCEPT, { type: 'concept', title: 'Storage', compiled_truth: 'Storage concept.', timeline: '', frontmatter: {} });
      for (let i = 0; i < 5; i++) {
        const atom = `atoms/storage-${i}`;
        await engine.putPage(atom, { type: 'note', title: atom, compiled_truth: `Atom ${i}.`, timeline: '', frontmatter: {} });
        await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,link_source)
          SELECT c.id, a.id, 'synthesized_from', 'concept-provenance' FROM pages c, pages a
           WHERE c.source_id='default' AND c.slug=$1 AND a.source_id='default' AND a.slug=$2
          UNION ALL
          SELECT a.id, c.id, 'synthesizes', 'concept-provenance' FROM pages c, pages a
           WHERE c.source_id='default' AND c.slug=$1 AND a.source_id='default' AND a.slug=$2`, [CONCEPT, atom]);
      }
      await engine.executeRaw('ANALYZE pages');
      await engine.executeRaw('ANALYZE links');
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('a republished concept reads only its own edges and retires those of the atom that left', async () => {
      const visited: Array<{ links: number; pages: number }> = [];
      const explaining = (tx: BrainEngine) => new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== 'executeRaw') return Reflect.get(target, prop, receiver);
          return async (sql: string, params?: unknown[]) => {
            if (sql.includes("link_source = 'concept-provenance'")) {
              const [plan] = await target.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
              const parsed = (typeof plan!['QUERY PLAN'] === 'string' ? JSON.parse(plan!['QUERY PLAN'] as string) : plan!['QUERY PLAN']) as Array<{ Plan: PlanNode }>;
              visited.push({ links: rowsVisited(parsed[0]!.Plan, 'links'), pages: rowsVisited(parsed[0]!.Plan, 'pages') });
            }
            return target.executeRaw(sql, params);
          };
        },
      });
      const wrapped = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
          return <T,>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(explaining(tx)));
        },
      });
      const revision = (await engine.readPageSnapshot(CONCEPT, { sourceId: 'default' }))!.revision;
      const members = [0, 1, 2, 3].map(i => `atoms/storage-${i}`);
      const links = members.flatMap(atom => [
        { from_slug: CONCEPT, to_slug: atom, link_type: 'synthesized_from', link_source: 'concept-provenance', from_source_id: 'default', to_source_id: 'default' },
        { from_slug: atom, to_slug: CONCEPT, link_type: 'synthesizes', link_source: 'concept-provenance', from_source_id: 'default', to_source_id: 'default' },
      ]);
      const result = await replaceConceptProvenanceLinks(wrapped, 'default', CONCEPT, links, { expectedRevision: revision, managed: false });
      expect(result).toEqual({ inserted: 0, retired: 2 });
      expect(visited.length).toBe(1);
      expect(visited[0]!.links).toBeLessThan(100);
      expect(visited[0]!.pages).toBeLessThan(100);
      const left = await engine.executeRaw<{ e: string }>(`SELECT f.slug || ' ' || t.slug AS e FROM links l JOIN pages f ON f.id=l.from_page_id
        JOIN pages t ON t.id=l.to_page_id WHERE l.link_source='concept-provenance' AND (f.slug=$1 OR t.slug=$1) ORDER BY 1`, [CONCEPT]);
      expect(left.map(r => r.e)).toEqual(members.flatMap(atom => [`${atom} ${CONCEPT}`, `${CONCEPT} ${atom}`]).sort());
    }, 120_000);
  });
}
