/**
 * `extract links|all --source db` (extractLinksFromDB) refreshes planner
 * statistics during its walk on PGLite (GBRA-75 wave 7). The walk rewrites
 * every page's links; without a refresh `links` keeps its pre-walk statistics
 * (none on a fresh brain), and the per-page link statements slowed from
 * 3.6 ms/page to about 180 ms/page on a 50k brain whose `links` table had
 * filled. The walk reuses the stale-drain upkeep (plannerStatsForLinkDrain):
 * a check before the first page, then every `import.analyze_every_pages`
 * walked pages, analyzing only tables past the F4b threshold.
 * Seam: planner-stats __testing.hooks.onAnalyzed (observes, changes nothing).
 * In-memory PGLite ($0).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __testing, LINK_DRAIN_ANALYZE_MIN_STALE, type PlannerRefreshReason } from '../src/core/planner-stats.ts';
import { withEnv } from './helpers/with-env.ts';

const PAGES = LINK_DRAIN_ANALYZE_MIN_STALE + 300;
const engines: PGLiteEngine[] = [];

beforeAll(() => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
});
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  resetGateway();
  __testing.hooks.onAnalyzed = undefined;
});

async function brainWithoutLinks(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  engines.push(engine);
  for (let i = 0; i < PAGES; i++) {
    await engine.putPage(`notes/page-${i}`, { type: 'note', title: `Page ${i}`,
      compiled_truth: `Page ${i}. Related: [[notes/page-${(i + 1) % PAGES}]] and [[notes/page-${(i + 7) % PAGES}]].` });
  }
  return engine;
}

async function walk(engine: PGLiteEngine, events: Array<{ reason: PlannerRefreshReason; table: string }>, args: string[] = []) {
  __testing.hooks.onAnalyzed = async (_engine, event) => { events.push({ reason: event.reason, table: event.table }); };
  try { await runExtract(engine, ['links', '--source', 'db', '--json', ...args]); }
  finally { __testing.hooks.onAnalyzed = undefined; }
}

test('the links walk analyzes `links` once it fills, and the same links land', async () => {
  const engine = await brainWithoutLinks();
  const events: Array<{ reason: PlannerRefreshReason; table: string }> = [];
  await walk(engine, events);
  expect(events.filter(e => e.reason === 'extract').map(e => e.table)).toContain('links');
  const [stats] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = 'public' AND tablename = 'links'");
  expect(stats!.n).toBeGreaterThan(0);
  const [links] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM links');
  expect(links!.n).toBe(PAGES * 2);
}, 180_000);

test('planner.auto_analyze=false: the links walk runs no ANALYZE', async () => {
  const engine = await brainWithoutLinks();
  const events: Array<{ reason: PlannerRefreshReason; table: string }> = [];
  await withEnv({ GBRAIN_PLANNER_AUTO_ANALYZE: 'false' }, () => walk(engine, events));
  expect(events).toEqual([]);
  const [links] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM links');
  expect(links!.n).toBe(PAGES * 2);
}, 180_000);

test('--dry-run walks without analyzing', async () => {
  const engine = await brainWithoutLinks();
  const events: Array<{ reason: PlannerRefreshReason; table: string }> = [];
  await walk(engine, events, ['--dry-run']);
  expect(events).toEqual([]);
}, 180_000);
