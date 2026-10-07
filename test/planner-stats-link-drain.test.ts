/**
 * PGLite stale link drains refresh planner statistics before their first page
 * (src/core/planner-stats.ts plannerStatsForLinkDrain). A brain that grew by
 * single writes since its last ANALYZE plans readPageSnapshot's
 * `slug = $1 AND source_id = $2` lookup as a scan of the whole source through
 * pages_dedup_idx; the drain must read it through pages_source_slug_key. Both
 * drains (unmanaged extractStaleFromDB, managed extractManagedStaleLinks) are
 * checked by EXPLAINing the real snapshot statement at its first execution
 * inside the drain; `planner.auto_analyze=false` keeps the drain from
 * analyzing. In-memory PGLite ($0).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __testing, LINK_DRAIN_ANALYZE_MIN_STALE, type PlannerRefreshReason } from '../src/core/planner-stats.ts';
import { withEnv } from './helpers/with-env.ts';

const PAGES = LINK_DRAIN_ANALYZE_MIN_STALE + 100;
const engines: PGLiteEngine[] = [];

beforeAll(() => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
});
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  resetGateway();
});

async function grownBrain(): Promise<PGLiteEngine> {
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

/** EXPLAIN the first readPageSnapshot statement the drain executes, with its own parameters. */
async function snapshotPlanDuringDrain(engine: PGLiteEngine, drain: () => Promise<unknown>): Promise<string> {
  let plan: string | null = null;
  const executeRaw = engine.executeRaw;
  engine.executeRaw = async function (this: PGLiteEngine, sql: string, params?: unknown[]) {
    if (plan === null && sql.trimStart().startsWith('WITH chosen AS')) {
      plan = (await executeRaw.call(this, `EXPLAIN ${sql}`, params) as Array<{ 'QUERY PLAN': string }>).map(r => r['QUERY PLAN']).join('\n');
    }
    return executeRaw.call(this, sql, params);
  } as typeof engine.executeRaw;
  try { await drain(); } finally { engine.executeRaw = executeRaw; }
  if (plan === null) throw new Error('the drain never read a page snapshot');
  return plan;
}

test('unmanaged extract --stale reads snapshots through pages_source_slug_key', async () => {
  const engine = await grownBrain();
  const analyzed: string[] = [];
  __testing.hooks.onAnalyzed = async (_engine, event) => { if (event.reason === 'extract') analyzed.push(event.table); };
  try {
    const plan = await snapshotPlanDuringDrain(engine, () =>
      extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true }));
    expect(plan).toContain('pages_source_slug_key');
    expect(plan).not.toContain('pages_dedup_idx');
    expect(analyzed).toContain('pages');
  } finally {
    __testing.hooks.onAnalyzed = undefined;
  }
}, 120_000);

test('managed extract --stale reads snapshots through pages_source_slug_key', async () => {
  const engine = await grownBrain();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const plan = await snapshotPlanDuringDrain(engine, () =>
    extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true }));
  expect(plan).toContain('pages_source_slug_key');
  expect(plan).not.toContain('pages_dedup_idx');
}, 120_000);

test('planner.auto_analyze=false: the drain runs no ANALYZE', async () => {
  const engine = await grownBrain();
  const reasons: PlannerRefreshReason[] = [];
  __testing.hooks.onAnalyzed = async (_engine, event) => { reasons.push(event.reason); };
  try {
    await withEnv({ GBRAIN_PLANNER_AUTO_ANALYZE: 'false' }, () =>
      extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true }));
    expect(reasons).toEqual([]);
  } finally {
    __testing.hooks.onAnalyzed = undefined;
  }
}, 120_000);
