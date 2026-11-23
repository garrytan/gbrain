/** #10176: a legacy Life Chronicle timeline projection row ranks no higher than its event page (agent_written). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { liftClaimedSources, recordSourceClaims } from '../src/core/trust/claim.ts';
import { relowerClaimedRows } from '../src/core/trust/backfill.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';

describe('chronicle timeline projection rows under a claim', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
      JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a claim does not lift the projection row above its agent_written event page', async () => {
    await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES($1, $1, $2)', ['demo', '/tmp/demo']);
    const page = async (slug: string, type: string, fm: object) => Number((await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages(slug, type, title, compiled_truth, source_id, frontmatter) VALUES($1, $2, 'T', 'Body.', 'demo', $3::text::jsonb) RETURNING id`,
      [slug, type, JSON.stringify(fm)]))[0]!.id);
    const depth = await page('notes/demo-day', 'note', {});
    const event = await page('life/events/demo-event', 'event', {
      event: { when: '2026-09-07', what: 'Call', kind: 'call', depth: 'notes/demo-day' }, captured_via: 'life-chronicle:auto',
    });
    const row = Number((await engine.executeRaw<{ id: number }>(
      `INSERT INTO timeline_entries(page_id, date, source, summary, event_page_id) VALUES($1, '2026-09-07', 'life-chronicle:event:life/events/demo-event', 'Call', $2) RETURNING id`,
      [depth, event]))[0]!.id);
    await recordSourceClaims(engine, ['demo']);
    await liftClaimedSources(engine);
    const tier = async (t: string, id: number) =>
      (await engine.executeRaw<{ t: string }>(`SELECT trust_tier t FROM ${t} WHERE id = $1`, [id]))[0]!.t;
    const got = { depth: await tier('pages', depth), event: await tier('pages', event), row: await tier('timeline_entries', row) };
    const pending = (await relowerClaimedRows(engine, { dryRun: true })).rows;
    expect({ ...got, pending }).toEqual({ depth: 'operator_curated', event: 'agent_written', row: 'agent_written', pending: 0 });
  }, 120_000);
});
