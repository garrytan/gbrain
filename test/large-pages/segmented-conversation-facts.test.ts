/**
 * Wave B PR 2 lane 2e2 (spec 8, full-pass mode): conversation facts read a
 * segmented page through ranged reads.
 *
 * 1. Protects:
 *    - a segmented conversation within the window cap gives the parser the
 *      inline page's input, and extract-conversation-facts hands the
 *      extractor the same windows;
 *    - over the cap, readSegmentedConversationInput reads only the newest
 *      whole segments that fit, the window is the suffix of the summary body,
 *      it carries the day-header date in force there, and its parse is the
 *      suffix of the whole body's parse (the same speakers, texts and times);
 *    - a page over the single-string ceiling with no conversation facts is
 *      extracted from its newest window with a `tail_window` receipt
 *      (`window_rule: no_prior_facts`) instead of skipped, reading at most
 *      the window's bytes;
 *    - one that already has conversation facts is skipped as in Wave A
 *      (`skipped_too_large`, `window_rule: prior_facts_kept`): no extraction,
 *      every fact, including those outside the window, is kept, and the
 *      window is never read (no segment text fetched, 0 segment bytes).
 * 2. Fails when: a segmented page reads its throwing body getters, the window
 *    is not the body's suffix or starts inside a forced run, its date context
 *    is lost, a read exceeds the window, a window run clears facts it
 *    cannot see, or a skipped page reads its window first.
 * 3. Why existing coverage misses it: conversation-facts tests use inline pages.
 * Seams: `segmentedPassWork.bytes` counts bytes read; a readSegmentTexts spy wraps the engine method.
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
import { CONVERSATION_WINDOW_BYTES, readSegmentedConversationInput } from '../../src/core/page-body/segment-conversation.ts';
import { segmentedPassWork } from '../../src/core/page-body/segment-blocks.ts';
import { materializedPage } from '../../src/core/persistence/segmented-apply.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
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
  test('within the cap: the parser input and the extractor windows match the inline page', async () => {
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
      expect(b).toEqual(a);
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

  test('a page over the single-string ceiling with no conversation facts is extracted from its newest window with a tail_window receipt, reading at most the window', async () => {
    for (const engine of engines) {
      await engine.setConfig('pages.segmented_storage', 'on');
      const file = join(dir, 'huge.md');
      writeFileSync(file, page('Huge', chat(PAGE_MAX_BYTES + 2 * 1024 * 1024, 11)));
      expect(await importFromFile(engine, file, 'conversations/huge.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }))
        .toMatchObject({ status: 'imported' });
      const huge = await stored(engine, 'conversations/huge');
      expect(Number(huge.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
      const before = segmentedPassWork.bytes;
      let calls = 0;
      let last = '';
      const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: ['conversations/huge'], sleepMs: 0, segmentLimit: 2,
        extractor: async input => { calls++; last = input.turnText; return []; } });
      expect(result.pages_skipped_too_large).toBe(0);
      expect(calls).toBeGreaterThan(0);
      expect(last.length).toBeGreaterThan(0);
      // One snapshot read of the window, plus the version-token recheck.
      expect(segmentedPassWork.bytes - before).toBeLessThanOrEqual(2 * CONVERSATION_WINDOW_BYTES);
      expect(await receiptOf(engine, huge.id)).toMatchObject({ kind: 'tail_window', pipeline: 'conversation_facts', total_bytes: Number(huge.body_bytes),
        cap_bytes: CONVERSATION_WINDOW_BYTES, origin: 'page', window_rule: 'no_prior_facts' });
    }
  }, 1_800_000);

  test('a page over the window that already has conversation facts keeps every one: skipped_too_large naming the rule, no extraction, nothing cleared, the window never read', async () => {
    const outcomes: unknown[] = [];
    const expected: unknown[] = [];
    for (const [index, engine] of engines.entries()) {
      const huge = await stored(engine, 'conversations/huge');
      // Facts from the head, which the newest window cannot see.
      for (const [rowNum, fact] of [[1000, 'Alice Example chose the launch budget'], [1001, 'Bob Example owns the roadmap review']] as const) {
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, source_markdown_slug, row_num, confidence, context)
          VALUES ('default', 'conversations/huge', $1, 'fact', 'private', 'medium', 'cli:extract-conversation-facts', 'conversations/huge', $2, 0.9,
            'from conversations/huge segment 2025-01-01T09:00:00Z..2025-01-01T11:00:00Z')`, [fact, rowNum]);
      }
      const facts = () => engine.executeRaw<Record<string, unknown>>(`SELECT id, fact, source, row_num, context, expired_at FROM facts
        WHERE source_id='default' AND source_markdown_slug='conversations/huge' ORDER BY id`);
      const before = await facts();
      expect(before.filter(row => row.source === 'cli:extract-conversation-facts')).toHaveLength(2);
      let calls = 0;
      // The window is never read: no segment text is fetched and no segment byte counted.
      const original = engine.readSegmentTexts.bind(engine);
      let segmentReads = 0;
      engine.readSegmentTexts = (async (sourceId: string, shas: Uint8Array[]) => { segmentReads += shas.length; return original(sourceId, shas); }) as BrainEngine['readSegmentTexts'];
      const bytesBefore = segmentedPassWork.bytes;
      let result: Awaited<ReturnType<typeof runExtractConversationFactsCore>>;
      try {
        result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: ['conversations/huge'], sleepMs: 0, segmentLimit: 2, force: true,
          extractor: async () => { calls++; return [{ fact: 'Carol Example ships the forecast', kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts' }]; } });
      } finally {
        // The spy is an own property; deleting it restores the prototype method.
        delete (engine as { readSegmentTexts?: unknown }).readSegmentTexts;
      }
      const bytesRead = segmentedPassWork.bytes - bytesBefore;
      const receipt = await receiptOf(engine, huge.id);
      outcomes.push({ engine: index, calls, segmentReads, bytesRead, skipped: result.pages_skipped_too_large, processed: result.pages_processed,
        factsKept: Bun.deepEquals(await facts(), before),
        receipt: { kind: receipt?.kind, processed_chars: receipt?.processed_chars, total_bytes: receipt?.total_bytes, cap_bytes: receipt?.cap_bytes,
          window_rule: receipt?.window_rule, prior_facts: receipt?.prior_facts } });
      expected.push({ engine: index, calls: 0, segmentReads: 0, bytesRead: 0, skipped: 1, processed: 0, factsKept: true,
        receipt: { kind: 'skipped_too_large', processed_chars: 0, total_bytes: Number(huge.body_bytes), cap_bytes: CONVERSATION_WINDOW_BYTES,
          window_rule: 'prior_facts_kept', prior_facts: 2 } });
    }
    expect(outcomes).toEqual(expected);
  }, 900_000);
});
