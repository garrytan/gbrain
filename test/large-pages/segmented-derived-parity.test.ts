/**
 * Wave B PR 2 lane 2e (spec 8, full-pass mode): the derived passes read a
 * segmented page one block at a time and give what they give the same body
 * held as strings.
 *
 * 1. Protects: on a multi-segment page holding links, role phrases, dated
 *    timeline bullets, a takes fence and entity mentions,
 *    - extractSegmentedPageLinks == extractPageLinks over the materialized
 *      body (candidates in order, unresolved refs, attendance) and its
 *      temporal inputs == temporalBodyOf;
 *    - parseTakesFenceBlocks == parseTakesFence (rows, warnings, marker scans);
 *    - segmentedTimelineText == parseTimelineEntries, and
 *      storedCanonicalTimeline is the same map for the unread and the
 *      materialized page;
 *    - pageMentions of the segmented row == findMentionedEntities of the
 *      joined strings;
 *    - planSegmentedExtraction == planExtraction for no watermark, a version
 *      change, a changed prefix, a matching prefix with a short and a long
 *      tail, a split code point and nothing appended;
 *    and every pass reads one segment text per readSegmentTexts call, never a
 *    block over one segment on a page without forced cuts.
 * 2. Fails when: a pass drops or reorders a candidate at a segment boundary,
 *    loses the context a window needs (headings, role priors, the text after
 *    a link), parses a fence or a timeline entry per segment where it spans
 *    them, or a planner reads the body as one string.
 * 3. Why existing coverage misses it: segmented-derived-work.test.ts checks
 *    outcomes on bodies whose links sit in the first segment.
 * Seams: none; the readSegmentTexts spy wraps the engine method.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { materializedPage } from '../../src/core/persistence/segmented-apply.ts';
import { extractPageLinks, makeResolver, parseTimelineEntries } from '../../src/core/link-extraction.ts';
import { loadActivePackForLocalEngine } from '../../src/core/schema-pack/best-effort.ts';
import { extractSegmentedPageLinks } from '../../src/core/page-body/segment-links.ts';
import { bodyBlocks } from '../../src/core/page-body/segment-blocks.ts';
import { parseTakesFenceBlocks } from '../../src/core/page-body/segment-takes.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { parseTakesFence, TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { temporalBodyOf } from '../../src/core/link-temporal-apply.ts';
import { segmentedTimelineText } from '../../src/core/timeline-extract.ts';
import { storedCanonicalTimeline } from '../../src/core/persistence/canonical-projections.ts';
import { pageMentions } from '../../src/core/mentions/pass.ts';
import { buildGazetteer, findMentionedEntities } from '../../src/core/by-mention.ts';
import { readMentionPolicy } from '../../src/core/mentions/policy.ts';
import { EXTRACTION_PIPELINE_VERSION, planExtraction, planSegmentedExtraction, type StoredWatermark } from '../../src/core/extraction-watermark.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const SLUG = 'meetings/segmented-parity';
const ROLE_SLUG = 'people/role-example';
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

/** About 3.5 MiB: conversation runs between paragraphs that link, name roles and mention entities; a takes fence mid-page; dated bullets in the timeline. */
function parityPage(): string {
  const parts: string[] = [];
  for (let i = 0; i < 12; i++) {
    parts.push(`## Section ${i}\n\n${conversationBody(260_000, { seed: 100 + i })}\n\n`);
    parts.push(`Met [[people/alice-example]] and [[people/p${i}-example]] about launch ${i}; she works at [Acme Example](../companies/acme-example.md), `
      + `[[people/p${i}-example]] advises [C${i}](../companies/c${i}-example.md) and invested in [[companies/missing-${i}-example]]. `
      + `Bob Example joined, see people/bob-example for notes, and Alice Example reviewed it.\n\n`);
    if (i === 6) parts.push(`${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n`
      + `| 1 | Acme ships quarterly | fact | world | 1.0 | 2026-01 | notes |\n| 2 | Pricing will hold | bet | brain | 0.6 | 2026-02 | notes |\n${TAKES_FENCE_END}\n\n`);
  }
  const timeline = Array.from({ length: 40 }, (_, i) => `- **2026-0${1 + (i % 9)}-${String(10 + (i % 18)).padStart(2, '0')}** | Met [[people/alice-example]] about item ${i}\n`
    + (i % 5 === 0 ? `  detail line for item ${i}\n` : '')).join('');
  return `---\ntype: meeting\ntitle: Parity\n---\n\n${parts.join('')}\n<!-- timeline -->\n\n${conversationBody(300_000, { seed: 7 })}\n\n${timeline}`;
}

/** Conversation without its `## Day` headings, so a section opened above it stays open across segments. */
const prose = (bytes: number, seed: number) => conversationBody(bytes, { seed }).replace(/^## Day \d+$/gm, 'Next day.');

/**
 * A person page whose page-role phrase comes last: links outside a machine section take the advisor prior, the one
 * under `## Related` (a later segment of that section, past any window's context) does not.
 */
function rolePage(): string {
  return `---\ntype: person\ntitle: Role Example\n---\n\nIntro: met [[companies/c1-example]] early.\n\n## Related\n\n${prose(1_600_000, 41)}\n\n`
    + `- [[companies/c2-example]]\n\n## Notes\n\n${prose(700_000, 42)}\n\nMet [[companies/c3-example]] again.\n\nRole Example is a senior advisor to founders.\n`;
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  const content = parityPage();
  for (const engine of engines) {
    await engine.setConfig('pages.segmented_storage', 'on');
    for (const [slug, type, title] of [['people/alice-example', 'person', 'Alice Example'], ['people/bob-example', 'person', 'Bob Example'],
      ['companies/acme-example', 'company', 'Acme Example']] as const) {
      await engine.putPage(slug, { type, title, compiled_truth: `${title} fixture.`, timeline: '', frontmatter: {} }, { sourceId: 'default' });
    }
    for (let i = 0; i < 12; i++) {
      await engine.putPage(`people/p${i}-example`, { type: 'person', title: `Person ${i}`, compiled_truth: 'Fixture person.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
      await engine.putPage(`companies/c${i}-example`, { type: 'company', title: `Company ${i}`, compiled_truth: 'Fixture company.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    }
    expect(await importFromContent(engine, SLUG, content, { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
    expect(await importFromContent(engine, ROLE_SLUG, rolePage(), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
  }
}, 300_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
});

/** The stored page (segmented, body unread) and the same page with its body read back as strings. */
async function pages(engine: BrainEngine, slug = SLUG) {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  expect(snapshot.page.body_storage).toBe('segmented');
  const inline = await materializedPage(engine, snapshot.page);
  return { snapshot, page: snapshot.page, inline, content: `${inline.compiled_truth}\n${inline.timeline}` };
}

/** Every segment text read while `run` runs: bytes per call and shas per call. */
async function readsDuring<T>(engine: BrainEngine, run: () => Promise<T>): Promise<{ result: T; calls: Array<{ shas: number; bytes: number }> }> {
  const original = engine.readSegmentTexts.bind(engine);
  const calls: Array<{ shas: number; bytes: number }> = [];
  engine.readSegmentTexts = (async (sourceId: string, shas: Uint8Array[]) => {
    const texts = await original(sourceId, shas);
    calls.push({ shas: shas.length, bytes: [...texts.values()].reduce((n, t) => n + t.length, 0) });
    return texts;
  }) as BrainEngine['readSegmentTexts'];
  try { return { result: await run(), calls }; } finally { engine.readSegmentTexts = original; }
}

describe('derived passes over a segmented page (full-pass mode)', () => {
  test('the page spans several segments with no forced cut, and each block is one segment', async () => {
    for (const engine of engines) {
      const { page } = await pages(engine);
      const rows = await engine.executeRaw<{ n: number; forced: number }>(
        "SELECT count(*)::int AS n, count(*) FILTER (WHERE cut_kind='forced')::int AS forced FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL", [page.id]);
      expect(rows[0]!.n).toBeGreaterThan(8);
      expect(rows[0]!.forced).toBe(0);
      const { result: sizes, calls } = await readsDuring(engine, async () => {
        const out: number[] = [];
        for await (const block of bodyBlocks(engine, page)) out.push(Buffer.byteLength(block.text, 'utf8'));
        return out;
      });
      expect(Math.max(...sizes)).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
      expect(calls.every(call => call.shas === 1 && call.bytes <= SEGMENT_MAX_BYTES)).toBe(true);
      expect(calls.length).toBe(rows[0]!.n);
    }
  }, 300_000);

  test('links: extractSegmentedPageLinks gives extractPageLinks over the materialized body, with the same temporal inputs', async () => {
    for (const engine of engines) {
      const { page, inline, content } = await pages(engine);
      const pack = (await loadActivePackForLocalEngine(engine, { sourceId: 'default' }))?.manifest ?? null;
      expect(pack).not.toBeNull();
      const resolver = makeResolver(engine, { mode: 'live', sourceId: 'default' });
      const opts = { pack, globalBasename: false, lineGrammar: { enabled: true, allowUndeclaredTypes: false } };
      const expected = await extractPageLinks(SLUG, content, inline.frontmatter, inline.type, resolver, opts);
      const { result: streamed, calls } = await readsDuring(engine, () => extractSegmentedPageLinks(engine,
        { id: Number(page.id), slug: SLUG, source_id: 'default', type: page.type, frontmatter: page.frontmatter }, resolver, { ...opts, temporal: true }));
      expect(expected.candidates.length).toBeGreaterThan(20);
      expect(streamed.candidates).toEqual(expected.candidates);
      expect(streamed.unresolved).toEqual(expected.unresolved);
      expect(streamed.attendanceComplete).toBe(expected.attendanceComplete);
      expect(streamed.temporalBody).toEqual(temporalBodyOf(inline));
      expect(calls.every(call => call.shas === 1)).toBe(true);
    }
  }, 300_000);

  test('links: a page-role prior from the last segment types links in the first, and a machine section opened segments earlier still suppresses it', async () => {
    for (const engine of engines) {
      const { page, inline, content } = await pages(engine, ROLE_SLUG);
      const [range] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL', [page.id]);
      expect(range!.n).toBeGreaterThan(3);
      const pack = (await loadActivePackForLocalEngine(engine, { sourceId: 'default' }))?.manifest ?? null;
      const resolver = makeResolver(engine, { mode: 'live', sourceId: 'default' });
      const opts = { pack, globalBasename: false };
      const expected = await extractPageLinks(ROLE_SLUG, content, inline.frontmatter, inline.type, resolver, opts);
      const streamed = await extractSegmentedPageLinks(engine, { id: Number(page.id), slug: ROLE_SLUG, source_id: 'default', type: page.type, frontmatter: page.frontmatter },
        resolver, opts);
      expect(Object.fromEntries(expected.candidates.map(c => [c.targetSlug, c.linkType])))
        .toEqual({ 'companies/c1-example': 'advises', 'companies/c2-example': 'mentions', 'companies/c3-example': 'advises' });
      expect(streamed.candidates).toEqual(expected.candidates);
    }
  }, 300_000);

  test('takes: parseTakesFenceBlocks gives parseTakesFence of the joined body', async () => {
    for (const engine of engines) {
      const { page, content } = await pages(engine);
      const streamed = await parseTakesFenceBlocks(bodyBlocks(engine, page), { slug: SLUG, source_id: 'default' });
      expect(streamed.parsed).toEqual(parseTakesFence(content));
      expect(streamed.parsed.takes.map(t => t.rowNum)).toEqual([1, 2]);
      expect({ begin: streamed.hasBegin, marker: streamed.hasMarker }).toEqual({ begin: true, marker: true });
    }
  }, 300_000);

  test('takes: a fence split across blocks at any line, a quoted marker in code, an end-only or a near-miss body all parse as the joined body', async () => {
    const table = '| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n'
      + '| 1 | Acme ships quarterly | fact | world | 1.0 | 2026-01 | notes |\n\n| 2 | Pricing will hold | bet | brain | 0.6 | 2026-02 | notes |\n';
    const bodies = [
      `Intro.\n\n\`\`\`md\n${TAKES_FENCE_BEGIN}\n\`\`\`\n\nMore.\n\n${TAKES_FENCE_BEGIN}\n${table}${TAKES_FENCE_END}\n\nTail.\n`,
      `Intro.\n\n${TAKES_FENCE_BEGIN}\n${table}\nNo end here.\n`,
      `Intro, long enough that the end marker sits past the begin marker's length.\n\nStray end:\n\n${TAKES_FENCE_END}\n`,
      `Intro.\n\n<!--- gbrain:takes:begin -->\n${table}`,
    ];
    for (const body of bodies) {
      const lines = body.split(/(?<=\n)/);
      for (let a = 1; a < lines.length; a++) {
        for (let b = a; b < lines.length; b++) {
          const cuts = [0, a, b, lines.length];
          const texts = cuts.slice(1).map((end, k) => lines.slice(cuts[k], end).join('')).filter(Boolean);
          if ([a, b].some(cut => lines.slice(0, cut).filter(line => line.startsWith('```')).length % 2 === 1)) continue;
          const blocks = async function* () { let at = 0; for (const text of texts) { yield { region: 'truth' as const, text, at }; at += text.length; } };
          const streamed = await parseTakesFenceBlocks(blocks(), { slug: SLUG, source_id: 'default' });
          expect(streamed.parsed).toEqual(parseTakesFence(body));
        }
      }
    }
  });

  test('timeline: segmentedTimelineText and storedCanonicalTimeline match the string readers', async () => {
    for (const engine of engines) {
      const { page, inline, content } = await pages(engine);
      const streamed = await segmentedTimelineText(engine, page);
      expect(streamed.entries).toEqual(parseTimelineEntries(content));
      expect(streamed.entries.length).toBeGreaterThanOrEqual(40);
      const unread = await storedCanonicalTimeline(engine, page, SLUG);
      const strings = await storedCanonicalTimeline(engine, inline, SLUG);
      expect([...unread]).toEqual([...strings]);
      expect(unread.size).toBeGreaterThanOrEqual(40);
    }
  }, 300_000);

  test('mentions: pageMentions of the segmented row matches findMentionedEntities of the joined strings', async () => {
    for (const engine of engines) {
      const { page, inline } = await pages(engine);
      const gazetteer = await buildGazetteer(engine, { policy: await readMentionPolicy(engine), strict: true });
      const opts = { fromSlug: SLUG, fromSourceId: 'default', allowCrossSource: false };
      const expected = findMentionedEntities(`${inline.title}\n\n${inline.compiled_truth}\n\n${inline.timeline}`, gazetteer, opts);
      const streamed = await pageMentions(engine, { id: Number(page.id), slug: SLUG, source_id: 'default', title: page.title, body_storage: 'segmented' }, gazetteer, opts);
      expect(expected.map(m => m.slug).sort()).toEqual(['companies/acme-example', 'people/alice-example', 'people/bob-example']);
      expect(streamed).toEqual(expected);
    }
  }, 300_000);

  test('extraction watermark: planSegmentedExtraction gives planExtraction for every watermark case', async () => {
    for (const engine of engines) {
      const { page, inline } = await pages(engine);
      const truth = Buffer.from(inline.compiled_truth, 'utf8');
      const mark = (bytes: number, sha = createHash('sha256').update(truth.subarray(0, bytes)).digest('hex'), version = EXTRACTION_PIPELINE_VERSION.facts_backstop): StoredWatermark =>
        ({ pipelineVersion: version, bytes, sha256: sha });
      const nearEnd = truth.lastIndexOf('\n', truth.length - 2000) + 1;
      const midChar = truth.indexOf(Buffer.from('—'));
      const cases: Array<[string, StoredWatermark | null]> = [
        ['none', null], ['version', mark(nearEnd, undefined, 0)], ['prefix', mark(nearEnd, 'f'.repeat(64))],
        ['short tail', mark(nearEnd)], ['long tail', mark(1000)], ['nothing appended', mark(truth.length)], ['past the end', mark(truth.length + 1)],
        ...(midChar > 0 ? [['split code point', mark(midChar + 1)] as [string, StoredWatermark]] : []),
      ];
      for (const [label, stored] of cases) {
        for (const emptyTail of ['skip', 'head'] as const) {
          const opts = { cap: 8_000, pipeline: 'facts_backstop' as const, emptyTail };
          const { result: plan, calls } = await readsDuring(engine, () => planSegmentedExtraction(engine, Number(page.id), stored, opts));
          expect({ label, plan }).toEqual({ label, plan: planExtraction(inline.compiled_truth, stored, opts) });
          expect(calls.every(call => call.shas === 1)).toBe(true);
        }
      }
    }
  }, 300_000);
});
