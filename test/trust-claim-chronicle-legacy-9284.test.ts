/** #9284: legacy life-chronicle events are model-produced: claim never lifts them above agent_written, relower lowers them. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { liftClaimedSources, recordSourceClaims } from '../src/core/trust/claim.ts';
import { relowerClaimedRows } from '../src/core/trust/backfill.ts';
import { withTrustBackfill } from '../src/core/persistence/context.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';

let engine: BrainEngine;
beforeAll(async () => {
  const pg = new PGLiteEngine(); await pg.connect({}); await pg.initSchema(); engine = pg;
  await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
    JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

const tier = async (id: number) =>
  (await engine.executeRaw<{ t: string }>(`SELECT trust_tier t FROM pages WHERE id=$1`, [id]))[0]!.t;

test('legacy chronicle events are capped at agent_written by claim and relower', async () => {
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES('own','own','/home/alice-example/notes')`);
  const page = async (slug: string, fm: object) => Number((await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages(slug,type,title,compiled_truth,source_id,frontmatter) VALUES($1,'event','T','Body.','own',$2::text::jsonb) RETURNING id`,
    [slug, JSON.stringify(fm)]))[0]!.id);
  const fm = { captured_via: 'life-chronicle:auto' };
  const fresh = await page('events/fresh', fm);
  const lifted = await page('events/lifted', fm);
  await recordSourceClaims(engine, ['own']);
  await engine.transaction(tx => withTrustBackfill(tx, () => tx.executeRaw(
    `UPDATE pages SET trust_tier='operator_curated', write_origin='{"channel":"trust_claim"}'::jsonb WHERE id=$1`, [lifted])));
  await liftClaimedSources(engine);
  expect(await tier(fresh)).toBe('agent_written');
  const report = await relowerClaimedRows(engine);
  expect(report.rows).toBeGreaterThanOrEqual(1);
  expect(await tier(lifted)).toBe('agent_written');
});
