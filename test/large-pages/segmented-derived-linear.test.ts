/**
 * Wave B PR 2 lane 2e (spec 8, full-pass mode): the derived passes over a
 * segmented page do O(page) work.
 *
 * Protects: links (with temporal inputs), takes, timeline (entries and the
 * stored canonical map), mentions, the watermark planner, the facts fence
 * view, the stale-cache file comparison and the conversation parser input,
 * run over a segmented page, count their work in `segmentedPassWork`: bytes read, units
 * of the blocks yielded and of the link windows built around them, and units
 * copied past a block (a takes fence join, the planner's tail window). Counts,
 * not CPU time, so a co-tenant cannot move them.
 * Fails when: at n and 2n bytes (n = 4 MiB) a counter exceeds its per-byte
 * bound, or (with at least MIN_RATIO_COUNT counts at n) grows 2.1x or more: a
 * window that keeps every earlier block as context, a planner tail that keeps
 * the whole appended text, a pass that re-reads the body per block. The forced
 * probe drives the same counted code to re-read the body's prefix before each
 * block and asserts the counts catch it.
 * Why existing coverage misses it: segmented-derived-parity checks results and
 * reads per call; segmented-derived-memory bounds memory, not work.
 * Seams: `segmentedPassWork` (@internal counters in segment-blocks.ts).
 * Measured (deterministic; per byte at n, doubling ratio): bytes 10.82 x1.99
 * (seven page reads: role phrases, link windows, takes, timeline, canonical
 * timeline, mentions, the planner's truth; the file read twice and the stored
 * body once for the stale-cache check; the conversation input; the fence view
 * reads only its marker segments), blocks 5.95 x1.99, windows 2.00 x2.00 (a
 * window holds the whole block before its own), carry 0.52 x1.99.
 * Prefix-re-reading driver (n = 1 MiB): bytes and blocks x2.68.
 * Manifest row visits (`bodyRowWork.visits`, read-range.ts; fix lane C1, finding C2): the passes visit each manifest
 * row a bounded number of times (measured 33.1 per row at both sizes), so visits per row stay under VISITS_PER_ROW. Row counts stay below
 * MIN_RATIO_COUNT, so the bound is per row, not a doubling ratio: a pass that filters the whole manifest for every
 * block visits rows x blocks, and its visits per row grow with the page (8 segments 80 visits, 16 segments 288).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { makeResolver } from '../../src/core/link-extraction.ts';
import { extractSegmentedPageLinks } from '../../src/core/page-body/segment-links.ts';
import { bodyBlocks, segmentedPassWork } from '../../src/core/page-body/segment-blocks.ts';
import { parseTakesFenceBlocks } from '../../src/core/page-body/segment-takes.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { segmentedBodyMatchesFile, segmentedFactsFenceView } from '../../src/core/page-body/segment-facts.ts';
import { readSegmentedConversationInput } from '../../src/core/page-body/segment-conversation.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { segmentedTimelineText } from '../../src/core/timeline-extract.ts';
import { storedCanonicalTimeline } from '../../src/core/persistence/canonical-projections.ts';
import { pageMentions } from '../../src/core/mentions/pass.ts';
import { buildGazetteer } from '../../src/core/by-mention.ts';
import { readMentionPolicy } from '../../src/core/mentions/policy.ts';
import { EXTRACTION_PIPELINE_VERSION, planSegmentedExtraction } from '../../src/core/extraction-watermark.ts';
import type { Page } from '../../src/core/types.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { countWorkAsync, describeWork, linearityViolations, MAX_DOUBLING_RATIO, type Sample } from '../helpers/work-counts.ts';
import { bodyRowWork } from '../../src/core/page-body/read-range.ts';

const MB = 1024 * 1024;
/** Per input byte, about 2x the measured value or more. */
const PER_BYTE = { 'pass.bytes': 22, 'pass.blocks': 12, 'pass.windows': 4, 'pass.carry': 1.2 };
/** Manifest row visits per live row over every pass, about 2x the measured value. */
const VISITS_PER_ROW = 66;

let engine: PGLiteEngine;
let dir: string;

/** `bytes` of linked, dated, mentioning conversation with a takes fence mid-page and dated bullets in the timeline. */
function page(bytes: number): string {
  const parts: string[] = [];
  const units = Math.round(bytes / (66 * 1024));
  for (let i = 0; i < units; i++) {
    parts.push(`## Section ${i}\n\n${conversationBody(64 * 1024, { seed: 100 + i })}\n\n`
      + `- **2026-03-${String(10 + (i % 18)).padStart(2, '0')}** Met [[people/alice-example]] and [Acme Example](../companies/acme-example.md) about launch ${i}; `
      + `Alice Example reviewed it.\n\n`);
    if (i === Math.floor(units / 3)) parts.push(`## Facts\n\n${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n`
      + `|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | Ships quarterly | fact | 1.0 | world | medium |  |  | notes |  |\n${FACTS_FENCE_END}\n\n`);
    if (i === Math.floor(units / 2)) parts.push(`${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n`
      + `| 1 | Acme ships quarterly | fact | world | 1.0 | 2026-01 | notes |\n${TAKES_FENCE_END}\n\n`);
  }
  const timeline = Array.from({ length: units }, (_, i) => `- **2026-0${1 + (i % 9)}-${String(10 + (i % 18)).padStart(2, '0')}** | Met [[people/alice-example]] about item ${i}\n`).join('');
  return `---\ntype: meeting\ntitle: Linear ${bytes}\n---\n\n${parts.join('')}\n<!-- timeline -->\n\n${timeline}`;
}

async function stored(slug: string): Promise<Page> {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  expect(snapshot.page.body_storage).toBe('segmented');
  return snapshot.page;
}

/** Every derived pass this lane streams, once over the page. */
async function passes(slug: string): Promise<void> {
  const p = await stored(slug);
  const resolver = makeResolver(engine, { mode: 'live', sourceId: 'default' });
  const links = await extractSegmentedPageLinks(engine, { id: Number(p.id), slug, source_id: 'default', type: p.type, frontmatter: p.frontmatter },
    resolver, { temporal: true, globalBasename: false });
  expect(links.candidates.length).toBeGreaterThan(0);
  expect((await parseTakesFenceBlocks(bodyBlocks(engine, p), { slug, source_id: 'default' })).parsed.takes).toHaveLength(1);
  expect((await segmentedTimelineText(engine, p)).entries.length).toBeGreaterThan(0);
  expect((await storedCanonicalTimeline(engine, p, slug)).size).toBeGreaterThan(0);
  const gazetteer = await buildGazetteer(engine, { policy: await readMentionPolicy(engine), strict: true });
  expect(await pageMentions(engine, { id: Number(p.id), slug, source_id: 'default', title: p.title, body_storage: 'segmented' }, gazetteer,
    { fromSlug: slug, fromSourceId: 'default', allowCrossSource: false })).not.toHaveLength(0);
  const half = Math.floor(Number((await engine.executeRaw<{ n: number }>(
    "SELECT coalesce(sum(byte_len),0)::bigint AS n FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL AND region='truth'", [p.id]))[0]!.n) / 2);
  const plan = await planSegmentedExtraction(engine, Number(p.id), { pipelineVersion: EXTRACTION_PIPELINE_VERSION.facts_backstop, bytes: half, sha256: '0'.repeat(64) },
    { cap: 8000, pipeline: 'facts_backstop', emptyTail: 'skip' });
  expect(plan.mode).toBe('head');
  expect((await segmentedFactsFenceView(engine, p)).body.facts).toHaveLength(1);
  expect(await segmentedBodyMatchesFile(engine, p, join(dir, `${slug.replace('/', '-')}.md`))).toBe('fresh');
  expect((await readSegmentedConversationInput(engine, p)).window).toBeUndefined();
}

/** The deliberately quadratic driver: re-reads the body's prefix through bodyBlocks before each block. */
async function prefixRereading(slug: string): Promise<void> {
  const p = await stored(slug);
  let seen = 0;
  for await (const _ of bodyBlocks(engine, p)) {
    let n = 0;
    for await (const __ of bodyBlocks(engine, p)) if (++n > seen) break;
    seen++;
  }
}

const sample = async (bytes: number, slug: string, run: (slug: string) => Promise<void>): Promise<Sample> =>
  ({ bytes, work: await countWorkAsync({ pass: segmentedPassWork, read: bodyRowWork }, () => run(slug)) });

async function liveRows(slug: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: unknown }>(`SELECT count(*) AS n FROM page_body_manifest m JOIN pages p ON p.id=m.page_id
    WHERE p.slug=$1 AND m.gen_to IS NULL AND m.staging_id IS NULL`, [slug]);
  return Number(row!.n);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'segmented-linear-'));
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.setConfig('pages.segmented_storage', 'on');
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Fixture.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'Fixture.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  for (const [slug, bytes] of [['notes/linear-1', MB], ['notes/linear-2', 2 * MB], ['notes/linear-4', 4 * MB], ['notes/linear-8', 8 * MB]] as const) {
    const content = page(bytes);
    writeFileSync(join(dir, `${slug.replace('/', '-')}.md`), content);
    expect(await importFromContent(engine, slug, content, { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
  }
}, 600_000);

afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

describe('derived pass work over a segmented page', () => {
  test('work per byte is bounded and doubles with the page', async () => {
    const a = await sample(4 * MB, 'notes/linear-4', passes);
    const b = await sample(8 * MB, 'notes/linear-8', passes);
    console.log(`[segmented-derived-linear] passes: ${describeWork(a, b)}`);
    expect(linearityViolations(a, b, PER_BYTE)).toEqual([]);
    const rows = [await liveRows('notes/linear-4'), await liveRows('notes/linear-8')];
    console.log(`[segmented-derived-linear] manifest visits per row: ${(a.work['read.visits']! / rows[0]!).toFixed(1)} (${rows[0]} rows), ${(b.work['read.visits']! / rows[1]!).toFixed(1)} (${rows[1]} rows)`);
    expect(a.work['read.visits']! / rows[0]!).toBeLessThanOrEqual(VISITS_PER_ROW);
    expect(b.work['read.visits']! / rows[1]!).toBeLessThanOrEqual(VISITS_PER_ROW);
  }, 300_000);

  test('forced probe: the same bounds fail a driver that re-reads the prefix before each block', async () => {
    const a = await sample(MB, 'notes/linear-1', prefixRereading);
    const b = await sample(2 * MB, 'notes/linear-2', prefixRereading);
    console.log(`[segmented-derived-linear] prefix-re-reading driver (quadratic probe): ${describeWork(a, b)}`);
    expect(b.work['pass.blocks']! / a.work['pass.blocks']!).toBeGreaterThan(MAX_DOUBLING_RATIO);
    expect(b.work['pass.bytes']! / a.work['pass.bytes']!).toBeGreaterThan(MAX_DOUBLING_RATIO);
  }, 300_000);
});
