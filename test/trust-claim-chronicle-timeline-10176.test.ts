/**
 * #10176: a Life Chronicle event's summary projected onto its depth page's timeline (`event_page_id`) ranks no higher
 * than the event page under a claim, as #9284 made the event page itself rank. The claim used to lift the projected row
 * to "your notes" next to an agent_written event page, and the relower found nothing to lower.
 *
 * PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { liftClaimedSources, recordSourceClaims } from '../src/core/trust/claim.ts';
import { relowerClaimedRows } from '../src/core/trust/backfill.ts';
import { withTrustBackfill } from '../src/core/persistence/context.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of testBackends()) {
  describe(`#10176 chronicle timeline projection rows under a claim (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
        JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
    }, 120_000);
    afterAll(async () => { await close(); });

    const seed = async (source: string) => {
      await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES($1, $1, $2)', [source, `/home/alice-example/${source}`]);
      const page = async (slug: string, type: string, fm: object) => Number((await engine.executeRaw<{ id: number }>(
        `INSERT INTO pages(slug, type, title, compiled_truth, source_id, frontmatter) VALUES($1, $2, 'T', 'Body.', $3, $4::text::jsonb) RETURNING id`,
        [slug, type, source, JSON.stringify(fm)]))[0]!.id);
      const depth = await page('notes/demo-day', 'note', {});
      const event = await page('life/events/demo-event', 'event', {
        event: { when: '2026-09-07', what: 'Call', kind: 'call', depth: 'notes/demo-day' }, captured_via: 'life-chronicle:auto' });
      const row = Number((await engine.executeRaw<{ id: number }>(
        `INSERT INTO timeline_entries(page_id, date, source, summary, event_page_id) VALUES($1, '2026-09-07', 'life-chronicle:event:life/events/demo-event', 'Call', $2) RETURNING id`,
        [depth, event]))[0]!.id);
      const plain = Number((await engine.executeRaw<{ id: number }>(
        `INSERT INTO timeline_entries(page_id, date, source, summary) VALUES($1, '2026-09-08', 'notes', 'Wrote it up') RETURNING id`, [depth]))[0]!.id);
      return { depth, event, row, plain };
    };
    const tier = async (table: string, id: number) => (await engine.executeRaw<{ t: string }>(`SELECT trust_tier AS t FROM ${table} WHERE id = $1`, [id]))[0]!.t;

    test('the claim lifts the depth page and its own timeline row, and keeps the projected row at its event page tier', async () => {
      const ids = await seed('demo');
      await recordSourceClaims(engine, ['demo']);
      await liftClaimedSources(engine);
      expect({ depth: await tier('pages', ids.depth), event: await tier('pages', ids.event), row: await tier('timeline_entries', ids.row),
        plain: await tier('timeline_entries', ids.plain) })
        .toEqual({ depth: 'operator_curated', event: 'agent_written', row: 'agent_written', plain: 'operator_curated' });
      expect((await relowerClaimedRows(engine, { dryRun: true, sources: ['demo'] })).rows).toBe(0);
    }, 120_000);

    test('the relower lowers a projected row an earlier claim lifted', async () => {
      const ids = await seed('lifted');
      await recordSourceClaims(engine, ['lifted']);
      // What a claim that ran before this fix left behind on the projected row.
      await engine.transaction(tx => withTrustBackfill(tx, () => tx.executeRaw(
        `UPDATE timeline_entries SET trust_tier = 'operator_curated', write_origin = '{"channel":"trust_claim"}'::jsonb WHERE id = $1`, [ids.row])));
      await liftClaimedSources(engine);
      const preview = await relowerClaimedRows(engine, { dryRun: true, sources: ['lifted'] });
      expect(preview.tables.find(t => t.table === 'timeline_entries')).toMatchObject({ rows: 1, to: { agent_written: 1 } });
      await relowerClaimedRows(engine, { sources: ['lifted'] });
      expect(await tier('timeline_entries', ids.row)).toBe('agent_written');
      expect(await tier('timeline_entries', ids.plain)).toBe('operator_curated');
    }, 120_000);
  });
}
