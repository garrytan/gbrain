/**
 * Perf budget for the owner-contact enrich order: at 100k pages the candidate
 * query answers in under 500 ms on PGLite, the plan's budget for the nightly
 * enrich_thin tick. The order is one statement of aggregated CTEs; a
 * regression to a subquery per candidate, or a scan of every link per page,
 * blows the budget long before 100k pages.
 *
 * Lane: slow (seeding 100k pages takes several seconds). Triggers are off
 * while seeding (session_replication_role = replica) because only pages,
 * links and their indexes matter to this query. The median of three runs is
 * compared, after one warm-up, so one noisy run does not fail it. Each run is
 * timed by the thread's CPU time (PGLite's WASM engine runs on the calling
 * thread): CI runs at about 200 ms, and a 504 ms wall-clock run was a runner
 * holding the thread off the CPU, which this budget is not about.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { cpuMsAsync } from './helpers/cpu-time.ts';

const PAGES = 100_000;
const BUDGET_MS = 500;

describe('owner-contact enrich order at 100k pages (PGLite)', () => {
  let engine: PGLiteEngine;
  const people = PAGES * 0.3;
  const meetings = PAGES * 0.4;
  const notes = PAGES - people - meetings;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw('SET session_replication_role = replica');
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth)
      SELECT 'default', 'people/p-' || g, 'person', 'P ' || g, 'stub' FROM generate_series(1, ${people}) g`);
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, effective_date)
      SELECT 'default', 'meetings/m-' || g, 'meeting', 'M ' || g, 'x', now() - ((g % 365) || ' days')::interval FROM generate_series(1, ${meetings}) g`);
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth)
      SELECT 'default', 'notes/n-' || g, 'note', 'N ' || g, 'x' FROM generate_series(1, ${notes}) g`);
    const [{ lo }] = await engine.executeRaw<{ lo: number }>(`SELECT min(id) AS lo FROM pages WHERE type = 'person'`);
    for (const [types, salt] of [[`'meeting'`, ''], [`'meeting', 'note'`, 'b']] as const) {
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type)
        SELECT m.id, ${Number(lo)} + (abs(hashtext(m.slug || '${salt}')) % ${people}), '' FROM pages m
         WHERE m.type IN (${types}) ON CONFLICT DO NOTHING`);
    }
    await engine.executeRaw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, counterparty_slug, summary, detector)
      SELECT 'default', 'k' || g, 'commitment_owed_to_me', 'people/p-' || g, 'x', 'manual' FROM generate_series(1, 1000) g`);
    await engine.executeRaw('SET session_replication_role = DEFAULT');
    await engine.executeRaw('ANALYZE');
  }, 300_000);

  afterAll(async () => { await engine.disconnect(); }, 60_000);

  test(`the candidate query answers in under ${BUDGET_MS} ms`, async () => {
    const run = async () => {
      let rows: Awaited<ReturnType<PGLiteEngine['listEnrichCandidates']>> = [];
      const ms = await cpuMsAsync(async () => {
        rows = await engine.listEnrichCandidates({
          types: ['person', 'company'], thinThreshold: 500, order: 'owner-contact', limit: 50,
          reenrichAfterMs: 30 * 86_400_000, sourceId: 'default', ownerSlug: 'people/p-1', ownerSourceId: 'default',
        });
      });
      return { ms, rows };
    };
    const warm = await run();
    expect(warm.rows.length).toBe(50);
    const times = [(await run()).ms, (await run()).ms, (await run()).ms].sort((a, b) => a - b);
    console.log(`[owner-contact perf] ${PAGES} pages: ${times.map((t) => Math.round(t)).join(', ')} ms of thread CPU`);
    expect(times[1]!).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
