/**
 * GST-3032 part 2, read side. A take or timeline row is owner-only by its own recorded inputs, not only by its page; this
 * file pins the write paths that decide where such rows land, and the read form used when a read has no schema version.
 *
 * 1. Protects: a take consolidated from facts lands only on a page in the facts' own source (facts derived from an
 *    iMessage page live in its source), so it is owner-only by its page; a meeting in an owner-only source never fans a
 *    timeline row onto a page in another source, even with link_resolution.cross_source on; a read whose schema version
 *    is unknown treats every row as owner-only on a brain that has held owner-only data, also after its last owner-only
 *    source is removed, and the v328 form reads the exact lineage.
 * 2. Fails when: consolidate resolves an entity page outside the facts' source, the extractor fans out of an owner-only
 *    source, or the closed form tests only for a live owner-only source.
 * 3. Real seams: runPhaseConsolidate, extractTimelineFromMeetings, the trigger-written marks and the v322 flag on PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { ownerOnlyPageSql, ownerOnlyTimelineSql } from '../src/core/access/owner-only.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('msgs', 'msgs', '{"kind":"imessage"}'::jsonb), ('vault', 'vault', '{"owner_only":true}'::jsonb)`);
}, 240_000);

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

const page = async (slug: string, sourceId: string, type = 'person') => Number((await engine.executeRaw<{ id: number }>(
  `INSERT INTO pages (slug, type, title, source_id) VALUES ($1, $2, $1, $3) RETURNING id`, [slug, type, sourceId]))[0]!.id);
const derive = (table: string, id: number, inputTable: string, inputId: number, sourceId: string) => engine.executeRaw(
  `INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ($1, $2, $3, $4, $5)`,
  [table, String(id), inputTable, String(inputId), sourceId]);
const unitVec = () => { const a = new Float32Array(1536); a[0] = 1; return '[' + Array.from(a).join(',') + ']'; };

describe('owner-only lineage, read side (GST-3032 part 2)', () => {
  test('consolidate writes a take only on a page in its facts\' own source, so a take from chat facts is owner-only by its page', async () => {
    const chat = await page('imessage/chat-1', 'msgs', 'imessage');
    await page('people/alice-example', 'default');
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    for (const word of ['alpha', 'beta', 'gamma']) {
      const [fact] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at, embedding_model, embedded_text_hash)
         VALUES ('msgs', 'people/alice-example', $1, 'fact', 'imessage', $2::timestamptz, $3::vector, $2::timestamptz, 'openai:text-embedding-3-large', md5($1)) RETURNING id`,
        [`alice likes the harbor plan ${word}`, old, unitVec()]);
      await derive('facts', fact!.id, 'pages', chat, 'msgs');
    }
    await runPhaseConsolidate(engine, { sourceId: 'msgs', minOldestAgeMs: 0, minFactsPerBucket: 2 });
    expect((await engine.executeRaw('SELECT 1 FROM takes')).length).toBe(0);

    await page('people/alice-example', 'msgs');
    await runPhaseConsolidate(engine, { sourceId: 'msgs', minOldestAgeMs: 0, minFactsPerBucket: 2 });
    const takes = await engine.executeRaw<{ source_id: string }>('SELECT p.source_id FROM takes t JOIN pages p ON p.id = t.page_id');
    expect(takes.map(t => t.source_id)).toEqual(['msgs']);
  }, 120_000);

  test('a meeting in an owner-only source never fans a timeline row into another source, cross-source links on', async () => {
    await page('people/bob-example', 'default');
    for (const [slug, sourceId] of [['meetings/vault-sync', 'vault'], ['meetings/open-sync', 'default']] as const) {
      await engine.executeRaw(`INSERT INTO pages (slug, type, title, source_id, compiled_truth, effective_date) VALUES ($1, 'meeting', $1, $2, 'notes', '2026-04-20')`, [slug, sourceId]);
      await engine.addLinksBatch([{ from_slug: slug, to_slug: 'people/bob-example', link_type: 'attended', link_source: 'manual', from_source_id: sourceId, to_source_id: 'default' }]);
    }
    const run = await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' }, () => extractTimelineFromMeetings(engine, { gazetteer: new Map() }));
    expect(run).toMatchObject({ meetings_scanned: 2, entries_created: 1 });
    expect((await engine.getTimeline('people/bob-example', { sourceId: 'default' })).map(e => e.source)).toEqual(['extract-timeline-from-meetings:meetings/open-sync']);
  }, 120_000);

  test('with no schema version a read counts every row owner-only once the brain has held owner-only data; the v328 form reads exact lineage', async () => {
    const origin = await page('notes/vault-origin', 'vault', 'note');
    const derived = await page('notes/derived-from-vault', 'default', 'note');
    const open = await page('notes/plainly-open', 'default', 'note');
    await derive('pages', derived, 'pages', origin, 'default');
    const holder = await page('people/carol-example', 'default');
    const [fanned] = await engine.executeRaw<{ id: number }>(`INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-04-20', 'Discussed in vault sync') RETURNING id`, [holder]);
    await derive('timeline_entries', fanned!.id, 'pages', origin, 'default');
    const verdicts = async () => (await engine.executeRaw<{ id: number; closed: boolean; exact: boolean }>(
      `SELECT p.id, ${ownerOnlyPageSql('p', 'closed')} AS closed, ${ownerOnlyPageSql('p', 'mode')} AS exact FROM pages p WHERE p.id = ANY($1::bigint[]) ORDER BY p.id`,
      [[derived, open]])).map(r => ({ id: Number(r.id), closed: r.closed, exact: r.exact }));
    const timeline = async () => (await engine.executeRaw<{ v: boolean }>(`SELECT ${ownerOnlyTimelineSql('te', 'mode')} AS v FROM timeline_entries te WHERE te.id = $1`, [fanned!.id]))[0]!.v;

    expect(await verdicts()).toEqual([{ id: derived, closed: true, exact: true }, { id: open, closed: true, exact: false }]);
    expect(await timeline()).toBe(true);
    // The last owner-only sources go: the marks keep the derived rows owner-only and the flag keeps the closed form closed.
    await engine.executeRaw(`DELETE FROM sources WHERE id IN ('vault', 'msgs')`);
    expect((await engine.executeRaw('SELECT 1 FROM sources WHERE config->>\'owner_only\' = \'true\' OR config->>\'kind\' = \'imessage\'')).length).toBe(0);
    expect(await verdicts()).toEqual([{ id: derived, closed: true, exact: true }, { id: open, closed: true, exact: false }]);
    expect(await timeline()).toBe(true);
  }, 120_000);
});
