/**
 * Cat7-1: the plan an engine picks for getTimeline's statement. The statement
 * is captured from the shared engine-sql builder with a recording executor and
 * explained on the real engine, so the plan is the one that call would run.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { TimelineOpts } from '../../src/core/types.ts';
import type { LegacyUnscopedRead } from '../../src/core/engine-sql/brands.ts';
import { renderFragment, type SqlFragment } from '../../src/core/engine-sql/fragment.ts';
import { getTimeline } from '../../src/core/engine-sql/timeline.ts';

export interface PlanScan { node: string; index?: string; cond?: string }

/** Every plan node that reads `pages`, with its index and index condition. */
export async function timelinePageScans(engine: BrainEngine, slug: string, opts?: TimelineOpts): Promise<PlanScan[]> {
  let statement: SqlFragment | undefined;
  const recorder = { dialect: engine.kind, run: async (f: SqlFragment) => { statement = f; return { rows: [], affectedRows: 0 }; } };
  await getTimeline(recorder as unknown as LegacyUnscopedRead, slug, opts);
  const { text, params } = renderFragment(statement!);
  const [row] = await engine.executeRaw<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${text}`, params);
  const raw = row['QUERY PLAN'];
  const scans: PlanScan[] = [];
  const walk = (node: Record<string, unknown>) => {
    if (node['Relation Name'] === 'pages') {
      scans.push({ node: String(node['Node Type']), index: node['Index Name'] as string | undefined, cond: (node['Index Cond'] ?? node['Recheck Cond']) as string | undefined });
    }
    for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  walk(((typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: Record<string, unknown> }[])[0].Plan);
  return scans;
}
