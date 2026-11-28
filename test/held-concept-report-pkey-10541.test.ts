/**
 * #10541: purge's held-concept report asks, per held concept, whether any live member is private. Its member join
 * compared `m.id::text = d.input_id`, so the planner could not use the pages primary key and read every page once per
 * held concept; on a large brain the report outlasted the statement timeout and stretched purge to minutes. The join
 * now compares on the integer side (guarded like facts-trust.ts, so a non-numeric or oversized input_id matches no
 * page instead of failing the cast). Measured from EXPLAIN ANALYZE of the statement the report sends; no timings.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readHeldConcepts } from '../src/core/persistence/concept-rebuild.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const FILLER = 6_000;
const HELD = 4;
const MEMBERS = 3;

type PlanNode = { 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; Plans?: PlanNode[] };
const pagesRowsRead = (node: PlanNode): number =>
  (node['Relation Name'] === 'pages' ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 1) : 0)
  + (node.Plans ?? []).reduce((sum, child) => sum + pagesRowsRead(child), 0);

for (const kind of testBackends()) {
  describe(`held-concept report member join (#10541, ${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
      await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth)
        SELECT 'default', 'filler/p-' || g, 'note', 'Filler ' || g, 'filler body' FROM generate_series(1, $1::int) g`, [FILLER]);
      for (let c = 0; c < HELD; c++) {
        const concept = `concepts/held-${c}`;
        await engine.putPage(concept, { type: 'concept', title: `Held ${c}`, compiled_truth: `Held concept ${c}.`, timeline: '', frontmatter: { synthesized_by: 'synthesize_concepts' } });
        for (let m = 0; m < MEMBERS; m++) {
          const atom = `atoms/held-${c}-${m}`;
          await engine.putPage(atom, { type: 'note', title: atom, compiled_truth: `Member ${m} of ${c}.`, timeline: '', frontmatter: {} });
          await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id)
            SELECT 'pages', c.id::text, 'pages', a.id::text, 'default' FROM pages c, pages a
             WHERE c.source_id = 'default' AND c.slug = $1 AND a.source_id = 'default' AND a.slug = $2`, [concept, atom]);
        }
        for (const odd of ['not-a-page-id', '99999999999999999999']) {
          await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id)
            SELECT 'pages', id::text, 'pages', $2, 'default' FROM pages WHERE source_id = 'default' AND slug = $1`, [concept, odd]);
        }
        await engine.executeRaw(`WITH d AS (UPDATE pages SET deleted_at = now() WHERE source_id = 'default' AND slug = $1 RETURNING id, deleted_at)
          INSERT INTO needs_rederive (derived_table, derived_id, source_id, reason, marked_at) SELECT 'pages', id::text, 'default', 'input_purged', deleted_at FROM d`, [concept]);
      }
      await engine.executeRaw('ANALYZE pages');
      await engine.executeRaw('ANALYZE derivation_inputs');
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('reads the held concepts and their members by primary key and still names every held concept', async () => {
      const read: number[] = [];
      const explaining = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop !== 'executeRaw') return Reflect.get(target, prop, receiver);
          return async (sql: string, params?: unknown[]) => {
            if (sql.includes('AS members_private')) {
              const [row] = await target.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
              const plan = row!['QUERY PLAN'];
              read.push(pagesRowsRead(((typeof plan === 'string' ? JSON.parse(plan) : plan) as Array<{ Plan: PlanNode }>)[0]!.Plan));
            }
            return target.executeRaw(sql, params);
          };
        },
      }) as BrainEngine;
      const report = await readHeldConcepts(explaining, true);
      expect(report.held.map(h => h.slug)).toEqual(Array.from({ length: HELD }, (_, c) => `concepts/held-${c}`));
      expect(read.length).toBe(1);
      expect(read[0]!).toBeLessThan(FILLER);
    }, 120_000);
  });
}
