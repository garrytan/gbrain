/**
 * #10541: the purge's held-concept report (readHeldConcepts) asks, per held concept, whether any live member is
 * private. Its member join compared `m.id::text = d.input_id`, so the planner could not use the pages primary key and
 * read every page once per held concept: on a large brain the report outlasted the statement timeout and stretched
 * the purge phase to minutes. The join now compares on the integer side. Measured from EXPLAIN (ANALYZE, FORMAT JSON)
 * of the statement the report sends, on a brain with thousands of pages; no wall-clock thresholds. Semantics: the
 * held set and the kept reasons are unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readHeldConcepts } from '../src/core/persistence/concept-rebuild.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const FILLER = 8_000;
const HELD = 5;
const MEMBERS = 3;

type PlanNode = { 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] };
function rowsVisited(node: PlanNode, relation: string): number {
  const own = node['Relation Name'] === relation
    ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * (node['Actual Loops'] ?? 1) : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + rowsVisited(child, relation), 0);
}

for (const kind of testBackends()) {
  describe(`held-concept report uses the pages primary key (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
        SELECT 'default', 'filler/p-' || g, 'note', 'Filler ' || g, 'filler body' FROM generate_series(1, $1::int) g`, [FILLER]);
      for (let c = 0; c < HELD; c++) {
        const concept = `concepts/held-${c}`;
        await engine.putPage(concept, { type: 'concept', title: `held ${c}`, compiled_truth: `Held concept ${c}.`, timeline: '',
          frontmatter: { synthesized_by: 'synthesize_concepts' } });
        for (let m = 0; m < MEMBERS; m++) {
          const atom = `atoms/held-${c}-${m}`;
          await engine.putPage(atom, { type: 'note', title: atom, compiled_truth: `Member ${m} of ${c}.`, timeline: '', frontmatter: {} });
          await engine.executeRaw(`INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id)
            SELECT 'pages', c.id::text, 'pages', a.id::text, 'default' FROM pages c, pages a
             WHERE c.source_id='default' AND c.slug=$1 AND a.source_id='default' AND a.slug=$2`, [concept, atom]);
        }
        // Hidden by an input purge: soft-deleted with a needs_rederive mark at the same instant (HELD_SQL).
        await engine.executeRaw(`WITH d AS (UPDATE pages SET deleted_at = now() WHERE source_id='default' AND slug=$1 RETURNING id, deleted_at)
          INSERT INTO needs_rederive(derived_table,derived_id,source_id,reason,marked_at) SELECT 'pages', id::text, 'default', 'input_purged', deleted_at FROM d`, [concept]);
      }
      await engine.executeRaw('ANALYZE pages');
      await engine.executeRaw('ANALYZE derivation_inputs');
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('the report reads only the held concepts and their members, and still names every held concept', async () => {
      const visited: number[] = [];
      const explaining = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop !== 'executeRaw') return Reflect.get(target, prop, receiver);
          return async (sql: string, params?: unknown[]) => {
            if (sql.includes('AS members_private')) {
              const [plan] = await target.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
              const parsed = (typeof plan!['QUERY PLAN'] === 'string' ? JSON.parse(plan!['QUERY PLAN'] as string) : plan!['QUERY PLAN']) as Array<{ Plan: PlanNode }>;
              visited.push(rowsVisited(parsed[0]!.Plan, 'pages'));
            }
            return target.executeRaw(sql, params);
          };
        },
      });
      const report = await readHeldConcepts(explaining, true);
      expect(report.held.map(h => h.slug)).toEqual(Array.from({ length: HELD }, (_, c) => `concepts/held-${c}`));
      expect(visited.length).toBe(1);
      // Held pages plus their members, a few lookups each; a scan of the filler would read FILLER × HELD rows.
      expect(visited[0]!).toBeLessThan(FILLER);
    }, 120_000);
  });
}
