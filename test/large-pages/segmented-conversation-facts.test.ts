/**
 * Wave B PR 2 lane 2e2 (spec 8, full-pass mode): conversation facts read a
 * segmented page through ranged reads. PR 4 lane 4b (spec 8.2) replaced the
 * page's single parser input with per-occurrence windows
 * (core/facts/conversation-incremental.ts; its append, retirement and spend
 * cases live in conversation-facts-incremental-*.test.ts).
 *
 * 1. Protects:
 *    - a segmented conversation within the window cap gives the parser the
 *      inline page's input (readConversationInput), and extract-conversation-facts
 *      hands the extractor exactly the windows each occurrence's own text
 *      yields: the inline page's rendered messages, cut at segment boundaries;
 *    - over the cap, readSegmentedConversationInput reads only the newest
 *      whole segments that fit, the window is the suffix of the summary body,
 *      it carries the day-header date in force there, and its parse is the
 *      suffix of the whole body's parse (the same speakers, texts and times);
 *    - a page over the single-string ceiling is extracted per occurrence,
 *      newest windows first; a run with no current grammar first detects it
 *      over the whole page once (conversationDetectionWork counts exactly the
 *      body's bytes), and every run, that one included, reads only the segment
 *      it extracts (at most SEGMENT_MAX_BYTES under --segment-limit 2); a run on
 *      the grammar the first one pinned reads nothing to detect it; its
 *      partial-input receipt is on the occurrence's derivation row instead of
 *      page_extraction_state;
 *    - such a run keeps the page's unanchored conversation facts (from
 *      earlier full-pass runs) untouched: a partial run never clears them.
 * 2. Fails when: a segmented page reads its throwing body getters, the window
 *    is not the body's suffix or starts inside a forced run, its date context
 *    is lost, a window spans a segment cut, a read exceeds the segment, or a
 *    partial run clears facts it cannot see.
 * 3. Why existing coverage misses it: conversation-facts tests use inline pages.
 * Seams: `segmentedPassWork.bytes` counts bytes read; `conversationDetectionWork.bytes` the grammar detection's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent, importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { readConversationInput, readSummaryBody } from '../../src/core/conversation-parser/body.ts';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';
import { CONVERSATION_WINDOW_BYTES, conversationDetectionWork, readSegmentedConversationInput } from '../../src/core/page-body/segment-conversation.ts';
import { segmentedPassWork } from '../../src/core/page-body/segment-blocks.ts';
import { materializedPage } from '../../src/core/persistence/segmented-apply.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { renderSegmentForExtraction, splitIntoSegments } from '../../src/core/facts/conversation-windows.ts';
import { withoutBody } from '../../src/core/page-body/page-shape.ts';
import type { Page } from '../../src/core/types.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let dir: string;

const WORDS = ['launch', 'pricing', 'budget', 'roadmap', 'hiring', 'review', 'contract', 'latency', 'onboarding', 'forecast', 'retention', 'deploy'];
const SPEAKERS = ['Alice Example', 'Bob Example', 'Carol Example'];

/** A dated chat log of about `bytes`: a `## YYYY-MM-DD` header per day, timed speaker turns under it. */
function chat(bytes: number, seed: number): string {
  let s = seed;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const parts: string[] = [];
  let size = 0;
  for (let day = 0; size < bytes; day++) {
    const date = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
    parts.push(`## ${date}\n\n`);
    for (let turn = 0; turn < 60; turn++) {
      const words = Array.from({ length: 10 + Math.floor(next() * 40) }, () => WORDS[Math.floor(next() * WORDS.length)]);
      const line = `**${SPEAKERS[turn % 3]}** (${9 + Math.floor(turn / 6)}:${String((turn * 7) % 60).padStart(2, '0')} AM): ${words.join(' ')}.\n\n`;
      parts.push(line);
      size += line.length;
    }
  }
  return parts.join('');
}

const page = (title: string, body: string) => `---\ntype: conversation\ntitle: ${title}\ndate: 2025-01-01\n---\n\n${body}`;
const SMALL = chat(1_500_000, 7);
const TAIL = chat(400_000, 9);
/** A chat log with a line longer than a segment (a run of forced cuts) shortly before its newest messages. */
const FORCED = `${chat(600_000, 8)}**Alice Example** (9:00 AM): ${'longline '.repeat(300_000)}\n\n${TAIL}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'segmented-conversation-'));
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) {
    for (const storage of ['inline', 'segmented'] as const) {
      await engine.setConfig('pages.segmented_storage', storage === 'segmented' ? 'on' : 'off');
      expect(await importFromContent(engine, `conversations/chat-${storage}`, page('Chat', SMALL), { sourceId: 'default', noEmbed: true }))
        .toMatchObject({ status: 'imported' });
      expect(await importFromContent(engine, `conversations/timeline-${storage}`, page('Timeline', `${SMALL}\n<!-- timeline -->\n\n${chat(300_000, 10)}`),
        { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
    }
    expect(await importFromContent(engine, 'conversations/forced-segmented', page('Forced', FORCED), { sourceId: 'default', noEmbed: true }))
      .toMatchObject({ status: 'imported' });
  }
}, 600_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
  rmSync(dir, { recursive: true, force: true });
});

const stored = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page;
const receiptOf = async (engine: BrainEngine, pageId: number) => (await engine.executeRaw<{ input_truncated: Record<string, unknown> | string }>(
  "SELECT input_truncated FROM page_extraction_state WHERE page_id=$1 AND pipeline='conversation_facts'", [pageId]))
  .map(row => typeof row.input_truncated === 'string' ? JSON.parse(row.input_truncated) : row.input_truncated)[0];

/** Every extractor input of one run over `slug`, with the run's counts. */
async function extraction(engine: BrainEngine, slug: string) {
  await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug=$1', [slug]);
  await engine.executeRaw("DELETE FROM page_segment_derivations WHERE page_id IN (SELECT id FROM pages WHERE source_id='default' AND slug=$1)", [slug]);
  const inputs: unknown[] = [];
  const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, force: true,
    extractor: async input => {
      inputs.push(Object.fromEntries(Object.entries(input).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
        .map(([k, v]) => [k, typeof v === 'string' ? v.replaceAll(slug, 'SLUG') : v])));
      return [];
    } });
  return { inputs, processed: result.pages_processed, segments: result.segments_processed, tooLarge: result.pages_skipped_too_large };
}

describe('conversation facts over a segmented page (full-pass mode)', () => {
  test('within the cap: the parser input matches the inline page; the extractor windows are the inline windows cut at the segment boundaries', async () => {
    for (const engine of engines) {
      const seg = await stored(engine, 'conversations/chat-segmented');
      expect(seg.body_storage).toBe('segmented');
      const inline = await stored(engine, 'conversations/chat-inline');
      expect(await readConversationInput(engine, seg)).toEqual({ body: readSummaryBody(inline) });
      // Truth and timeline joined as readSummaryBody joins them.
      const withTimeline = await stored(engine, 'conversations/timeline-segmented');
      expect(withTimeline.body_storage).toBe('segmented');
      const inlineTimeline = await stored(engine, 'conversations/timeline-inline');
      expect(inlineTimeline.timeline.length).toBeGreaterThan(100_000);
      expect(await readConversationInput(engine, withTimeline)).toEqual({ body: readSummaryBody(inlineTimeline) });
      const a = await extraction(engine, 'conversations/chat-inline');
      const b = await extraction(engine, 'conversations/chat-segmented');
      expect(a.inputs.length).toBeGreaterThan(10);
      // PR 4 (wave-b spec 8.2): a segmented page's windows are packed inside one occurrence and never span a cut.
      // Exactly the windows each occurrence's own text yields, read here from the materialized body.
      const manifest = await engine.readManifest(seg.id);
      const truth = Buffer.from((await materializedPage(engine, seg)).compiled_truth, 'utf8');
      const pageArg = { ...withoutBody(seg), compiled_truth: '', timeline: '' } as Page;
      const expected = manifest.flatMap(row => {
        const fallbackDate = (row.entryState as { conversation?: { fallbackDate?: string | null } }).conversation?.fallbackDate ?? undefined;
        const text = truth.subarray(row.byteStart, row.byteStart + row.byteLen).toString('utf8');
        const messages = parseConversation(text, { page: pageArg, ...(fallbackDate ? { fallbackDate } : {}) }).messages;
        return splitIntoSegments(messages, { pageTitle: 'Chat' }).map(window => renderSegmentForExtraction('Chat', window));
      });
      const texts = (r: typeof b) => r.inputs.map(input => (input as { turnText: string }).turnText);
      expect(manifest.length).toBeGreaterThan(2);
      expect([...texts(b)].sort()).toEqual([...expected].sort());
      // The same rendered messages as the inline page, less only the turns a cut leaves alone in their gap group.
      const lines = (r: typeof b) => texts(r).flatMap(text => text.split('\n---\n')[1]!.split('\n'));
      const inlineLines = new Map<string, number>();
      for (const line of lines(a)) inlineLines.set(line, (inlineLines.get(line) ?? 0) + 1);
      for (const line of lines(b)) { expect(inlineLines.get(line) ?? 0).toBeGreaterThan(0); inlineLines.set(line, inlineLines.get(line)! - 1); }
      expect(lines(a).length - lines(b).length).toBeLessThanOrEqual(2 * (manifest.length - 1));
      const fixed = (r: typeof b) => r.inputs.map(input => ({ ...(input as Record<string, unknown>), turnText: undefined }));
      expect(new Set(fixed(b).map(input => JSON.stringify(input)))).toEqual(new Set([JSON.stringify(fixed(a)[0])]));
      expect({ processed: b.processed, segments: b.segments, tooLarge: b.tooLarge }).toEqual({ processed: 1, segments: expected.length, tooLarge: 0 });
    }
  }, 600_000);

  test('over the cap: the newest whole segments that fit, the body suffix, its day date, and the suffix of the parse', async () => {
    for (const engine of engines) {
      const seg = await stored(engine, 'conversations/chat-segmented');
      const whole = readSummaryBody(await materializedPage(engine, seg));
      const cap = 900_000;
      const before = segmentedPassWork.bytes;
      const input = await readSegmentedConversationInput(engine, seg, cap);
      expect(segmentedPassWork.bytes - before).toBeLessThanOrEqual(cap);
      expect(Buffer.byteLength(input.body)).toBeGreaterThan(cap / 3);
      expect(whole.endsWith(input.body)).toBe(true);
      const head = whole.slice(0, whole.length - input.body.length);
      const dates = [...head.matchAll(/^## (\d{4}-\d{2}-\d{2})$/gm)].map(m => m[1]);
      expect(input.window).toEqual({ totalBytes: Number(seg.body_bytes), fallbackDate: dates.at(-1)! });
      const pageArg = { ...withoutBody(seg), compiled_truth: '', timeline: '' } as Page;
      const full = parseConversation(whole, { page: pageArg }).messages;
      const tail = parseConversation(input.body, { page: pageArg, fallbackDate: input.window!.fallbackDate! }).messages;
      expect(tail.length).toBeGreaterThan(100);
      const pick = (m: { speaker: string; text: string; timestamp?: unknown }) => ({ speaker: m.speaker, text: m.text, timestamp: m.timestamp });
      expect(tail.map(pick)).toEqual(full.slice(full.length - tail.length).map(pick));
    }
  }, 300_000);

  test('over the cap: a window whose edge falls inside a run of forced cuts starts after the run', async () => {
    for (const engine of engines) {
      const seg = await stored(engine, 'conversations/forced-segmented');
      expect(seg.body_storage).toBe('segmented');
      const [forced] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL AND cut_kind='forced'`, [seg.id]);
      expect(forced!.n).toBeGreaterThan(1);
      const whole = readSummaryBody(await materializedPage(engine, seg));
      const input = await readSegmentedConversationInput(engine, seg, Buffer.byteLength(TAIL) + 1_500_000);
      expect(whole.endsWith(input.body)).toBe(true);
      expect(input.body.length).toBeGreaterThan(TAIL.length / 2);
      expect(input.body).not.toContain('longline');
    }
  }, 300_000);

  test('a page over the single-string ceiling is extracted per occurrence, newest windows first: the grammar is detected over the whole page once, apart, and each run reads only the occurrence it extracts', async () => {
    for (const engine of engines) {
      await engine.setConfig('pages.segmented_storage', 'on');
      const file = join(dir, 'huge.md');
      const body = chat(PAGE_MAX_BYTES + 2 * 1024 * 1024, 11);
      writeFileSync(file, page('Huge', body));
      expect(await importFromFile(engine, file, 'conversations/huge.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }))
        .toMatchObject({ status: 'imported' });
      const huge = await stored(engine, 'conversations/huge');
      expect(Number(huge.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
      const before = segmentedPassWork.bytes;
      const detectedBefore = conversationDetectionWork.bytes;
      const texts: string[] = [];
      const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: ['conversations/huge'], sleepMs: 0, segmentLimit: 2,
        extractor: async input => { texts.push(input.turnText); return []; } });
      expect({ tooLarge: result.pages_skipped_too_large, calls: texts.length }).toEqual({ tooLarge: 0, calls: 2 });
      // The first run has no current grammar: it detects it over the whole page once, counted apart from the extraction's reads.
      expect(conversationDetectionWork.bytes - detectedBefore).toBe(Number(huge.body_bytes));
      // The extraction reads one segment (the newest occurrence's), never the 24 MiB window.
      expect(segmentedPassWork.bytes - before).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
      expect(texts[0]).toContain([...body.matchAll(/^## (\d{4}-\d{2}-\d{2})$/gm)].at(-1)![1]);
      // The partial-input receipt moved to the occurrence's derivation row.
      expect(await receiptOf(engine, huge.id)).toBeUndefined();
      const rows = await engine.readSegmentDerivations(huge.id, { kind: 'conversation_facts' });
      expect(rows.map(row => ({ state: row.state, receipt: row.receipt }))).toEqual([{ state: 'partial',
        receipt: expect.objectContaining({ kind: 'unread_windows', pipeline: 'conversation_facts', reason: 'segment_limit', windows_read: 2 }) }]);
      // A run on the grammar the first run pinned detects nothing and again reads only the segment it extracts.
      const pinnedBefore = segmentedPassWork.bytes;
      const detectedAgain = conversationDetectionWork.bytes;
      const next = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: ['conversations/huge'], sleepMs: 0, segmentLimit: 2,
        extractor: async input => { texts.push(input.turnText); return []; } });
      expect({ tooLarge: next.pages_skipped_too_large, calls: texts.length, detected: conversationDetectionWork.bytes - detectedAgain })
        .toEqual({ tooLarge: 0, calls: 4, detected: 0 });
      expect(segmentedPassWork.bytes - pinnedBefore).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    }
  }, 1_800_000);

  test('a page over the window keeps its unanchored conversation facts while a partial run extracts its newest windows', async () => {
    const outcomes: unknown[] = [];
    const expected: unknown[] = [];
    for (const [index, engine] of engines.entries()) {
      const huge = await stored(engine, 'conversations/huge');
      await engine.executeRaw('DELETE FROM page_segment_derivations WHERE page_id=$1', [huge.id]);
      // Facts from the head, which no window this run extracts can see.
      for (const [rowNum, fact] of [[1000, 'Alice Example chose the launch budget'], [1001, 'Bob Example owns the roadmap review']] as const) {
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, source_markdown_slug, row_num, confidence, context)
          VALUES ('default', 'conversations/huge', $1, 'fact', 'private', 'medium', 'cli:extract-conversation-facts', 'conversations/huge', $2, 0.9,
            'from conversations/huge segment 2025-01-01T09:00:00Z..2025-01-01T11:00:00Z')`, [fact, rowNum]);
      }
      const facts = () => engine.executeRaw<Record<string, unknown>>(`SELECT id, fact, source, row_num, context, expired_at FROM facts
        WHERE source_id='default' AND source_markdown_slug='conversations/huge' AND source_window IS NULL ORDER BY id`);
      const before = await facts();
      expect(before.filter(row => row.source === 'cli:extract-conversation-facts')).toHaveLength(2);
      let calls = 0;
      const bytesBefore = segmentedPassWork.bytes;
      const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: ['conversations/huge'], sleepMs: 0, segmentLimit: 2, force: true,
        extractor: async () => { calls++; return [{ fact: `Carol Example ships the forecast ${calls}`, kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts' }]; } });
      const [anchored] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug='conversations/huge'
        AND source_window IS NOT NULL AND jsonb_typeof(source_window)='object'`);
      outcomes.push({ engine: index, calls, readWithinSegment: segmentedPassWork.bytes - bytesBefore <= SEGMENT_MAX_BYTES, skipped: result.pages_skipped_too_large,
        unanchoredKept: Bun.deepEquals(await facts(), before), anchored: Number(anchored!.n), receipt: await receiptOf(engine, huge.id) });
      expected.push({ engine: index, calls: 2, readWithinSegment: true, skipped: 0, unanchoredKept: true, anchored: 2, receipt: undefined });
    }
    expect(outcomes).toEqual(expected);
  }, 900_000);
});
