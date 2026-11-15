/**
 * GST-2768 PR 2: backfilled archive pages are keyword-only with their embedding held (reason archive_backfill) in the
 * existing page_embedding_budget ledger, whatever their size, so the embed sweep sends nothing until the owner approves
 * the previewed cost (gbrain embed --held). Pages the forward run writes for closed days are not held. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { planPageEmbedding } from '../src/core/page-embedding-budget.ts';
import { readBudgetLimited } from '../src/core/held-embedding.ts';
import { ARCHIVE_BACKFILL_HOLD_REASON, ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { conversation, staticReader } from './helpers/transcript-archive.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

async function pageRow(slug: string, sourceId = 'conversations') {
  const [row] = await engine.executeRaw<{ id: number; compiled_truth: string; body_storage: 'inline' | 'segmented' | null }>(
    'SELECT id, compiled_truth, body_storage FROM pages WHERE slug = $1 AND source_id = $2', [slug, sourceId]);
  return row!;
}
const stale = [{ chunk_index: 0, chunk_text: 'some chunk text' }];

describe('backfill embedding hold (pglite)', () => {
  test('backfilled pages carry a held embedding and nothing is granted before approval', async () => {
    const result = await runTranscriptArchive(engine, {
      mode: 'backfill', from: '2026-09-01', to: '2026-09-02',
      readers: [staticReader('codex', [conversation('codex', 'rollout-old', [['user', '2026-09-01T10:00:00.000Z', 'old work'], ['user', '2026-09-02T10:00:00.000Z', 'more old work']])])],
      now: new Date('2026-11-01T00:00:00Z'),
    });
    const slugs = result.days.filter(d => d.status === 'written').map(d => d.slug!);
    expect(slugs.length).toBe(2);
    const holds = await engine.executeRaw<{ slug: string; state: string; reason: string }>(
      'SELECT p.slug, b.state, b.reason FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id ORDER BY p.slug');
    expect(holds.filter(h => slugs.includes(h.slug)).map(h => [h.state, h.reason])).toEqual([['held', ARCHIVE_BACKFILL_HOLD_REASON], ['held', ARCHIVE_BACKFILL_HOLD_REASON]]);
    expect((await readBudgetLimited(engine, { sourceId: 'conversations' })).held_reasons[ARCHIVE_BACKFILL_HOLD_REASON]).toBe(2);
    for (const slug of slugs) {
      expect((await planPageEmbedding(engine, await pageRow(slug), stale)).kind).toBe('held');
      expect((await planPageEmbedding(engine, await pageRow(slug), stale, { approvedCapUsd: 0.01 })).kind).not.toBe('held');
      expect((await planPageEmbedding(engine, await pageRow(slug), stale)).kind).toBe('unmetered');
    }
  }, 60_000);

  test('a backfilled page published before its hold row is still held on its first embedding plan', async () => {
    const result = await runTranscriptArchive(engine, {
      mode: 'backfill', from: '2026-09-01', to: '2026-09-01',
      readers: [staticReader('codex', [conversation('codex', 'rollout-race', [['user', '2026-09-01T10:00:00.000Z', 'raced work']])])],
      now: new Date('2026-11-01T00:00:00Z'),
    });
    const slug = result.days.find(d => d.status === 'written')!.slug!;
    const page = await pageRow(slug);
    await engine.executeRaw('DELETE FROM page_embedding_budget WHERE page_id = $1', [page.id]);
    expect(await planPageEmbedding(engine, page, stale)).toEqual({ kind: 'held', reason: ARCHIVE_BACKFILL_HOLD_REASON });
    expect((await readBudgetLimited(engine, { sourceId: 'conversations' })).held_reasons[ARCHIVE_BACKFILL_HOLD_REASON]).toBe(1);
  }, 60_000);

  test('an ordinary small page and a forward-run closed day stay unmetered', async () => {
    await importFromContent(engine, 'notes/plain', '---\ntype: note\ntitle: Plain\n---\nplain body', { noEmbed: true });
    expect((await planPageEmbedding(engine, await pageRow('notes/plain', 'default'), stale)).kind).toBe('unmetered');
    const result = await runTranscriptArchive(engine, {
      mode: 'run', readers: [staticReader('codex', [conversation('codex', 'rollout-new', [['user', '2026-11-09T10:00:00.000Z', 'yesterday']])])],
      now: new Date('2026-11-10T12:00:00Z'),
    });
    const slug = result.days.find(d => d.status === 'written')!.slug!;
    expect((await planPageEmbedding(engine, await pageRow(slug), stale)).kind).toBe('unmetered');
  }, 60_000);
});
