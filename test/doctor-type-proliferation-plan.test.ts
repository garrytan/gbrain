/**
 * Doctor `type_proliferation` reads the distinct (source, type) pairs of live
 * typed pages without visiting every page.
 *
 * Protects: the check's one read of `pages` reaches it only through index
 * probes on idx_pages_source_type (v316), never a sequential scan, and returns
 * exactly the pairs `SELECT DISTINCT source_id, type` returns (deleted pages
 * left out).
 * Fails when: the read goes back to `SELECT DISTINCT source_id, type FROM
 * pages`, which scans every page row (over 20 s on a large brain), or the
 * index is missing.
 * Seams: executeRaw is wrapped to record the statements the check runs;
 * in-memory PGLite with planner statistics.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkTypeProliferation } from '../src/core/onboard/checks.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title)
    SELECT 'default', 'notes/n-' || g, (ARRAY['note', 'meeting', 'person', 'company', 'project', 'idea'])[1 + g % 6], 'n' FROM generate_series(1, 3000) g`);
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title)
    SELECT 'source-a', 'notes/a-' || g, (ARRAY['note', 'transcript', 'call'])[1 + g % 3], 'a' FROM generate_series(1, 600) g`);
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, deleted_at) VALUES ('source-a', 'notes/gone', 'deleted-only', 'gone', now())`);
  await engine.executeRaw('ANALYZE pages');
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
const walk = (node: PlanNode, out: PlanNode[] = []): PlanNode[] => { out.push(node); for (const child of node.Plans ?? []) walk(child, out); return out; };

test('the check reads pages once, through index probes only, and gets every live typed pair', async () => {
  const statements: string[] = [];
  const raw = engine.executeRaw.bind(engine);
  engine.executeRaw = ((sql: string, params?: unknown[]) => { statements.push(sql); return raw(sql, params); }) as typeof engine.executeRaw;
  try {
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, () => checkTypeProliferation(engine));
  } finally { engine.executeRaw = raw; }

  const pageReads = statements.filter(sql => /\bpages\b/i.test(sql) && /^\s*(WITH|SELECT)/i.test(sql));
  expect(pageReads.length).toBe(1);
  const [{ 'QUERY PLAN': plan }] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (FORMAT JSON) ${pageReads[0]}`);
  const scans = walk(plan[0].Plan).filter(node => node['Relation Name'] === 'pages');
  expect(scans.length).toBeGreaterThan(0);
  for (const scan of scans) expect({ node: scan['Node Type'], index: scan['Index Name'] }).toEqual({ node: expect.stringMatching(/^Index (Only )?Scan$/), index: 'idx_pages_source_type' });

  const pairs = await engine.executeRaw<{ source_id: string; type: string }>(pageReads[0]);
  const distinct = await engine.executeRaw<{ source_id: string; type: string }>(
    'SELECT DISTINCT source_id, type FROM pages WHERE deleted_at IS NULL AND type IS NOT NULL ORDER BY source_id, type');
  expect(pairs).toEqual(distinct);
  expect(pairs.length).toBe(9);
});
