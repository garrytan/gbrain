/**
 * Wave B PR 2 lane 2e (spec 8, full-pass mode): the derived passes' memory
 * does not follow the page.
 *
 * Protects: on PGLite, in a fresh child process per page, running every
 * streamed derived pass (links with temporal inputs, the canonical timeline,
 * the timeline keys, the takes fence, mentions, the facts-backstop extraction
 * plan) over a 40 MiB segmented page (streamed import, over the 24 MiB
 * single-string ceiling)
 * - keeps under RETAINED_LIMIT_MIB of live heap above the start (taken after
 *   one warm-up read of every segment, so PGLite's WASM memory has grown to its
 *   high water), sampled after a full collection every 16th segment read (one
 *   segment at a time: ~8 MiB measured; ~111 MiB when kept link candidates and
 *   timeline entries pinned the windows they were cut from; a pass holding the
 *   body would retain 40 MiB or more), and
 * - peaks (VmHWM, reset after the import) under PEAK_DELTA_LIMIT_MIB above the
 *   same passes over a 4 MiB page (~60 MiB measured; ~700 MiB without the
 *   block reader's collection every 4 MiB);
 * and every pass finds what it should on both pages.
 * Fails when: a pass reads the body as one string (materializedPage, a joined
 * block list), keeps every block's text alive until the pass ends, or the
 * reader stops collecting the garbage each segment read leaves.
 * Why existing coverage misses it: segmented-derived-parity.test.ts checks
 * results on a 3.5 MiB page, not memory.
 * Seams: a child process per page (VmHWM is per process); no mocks.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { conversationBody } from '../helpers/conversation-page.ts';

const REPO = resolve(import.meta.dir, '../..');
const PEAK_DELTA_LIMIT_MIB = 160;
const RETAINED_LIMIT_MIB = 24;
const dir = mkdtempSync(join(tmpdir(), 'segmented-derived-memory-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NAMES = ['Amber', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fjord', 'Grove', 'Harbor']
  .flatMap(first => ['Vale', 'Ridge', 'Brook', 'Field', 'Stone', 'Marsh', 'Glen', 'Crest'].map(last => `${first} ${last}`));
const src = (path: string) => JSON.stringify(join(REPO, 'src', path));
const CHILD = `
import { readFileSync, writeFileSync } from 'node:fs';
import { heapStats } from 'bun:jsc';
import { createEngine } from ${src('core/engine-factory.ts')};
import { importFromFile } from ${src('core/import-file.ts')};
import { readPageBodyPolicy } from ${src('core/page-body/limits.ts')};
import { makeResolver } from ${src('core/link-extraction.ts')};
import { loadActivePackForLocalEngine } from ${src('core/schema-pack/best-effort.ts')};
import { extractSegmentedPageLinks } from ${src('core/page-body/segment-links.ts')};
import { bodyBlocks } from ${src('core/page-body/segment-blocks.ts')};
import { parseTakesFenceBlocks } from ${src('core/page-body/segment-takes.ts')};
import { segmentedTimelineText } from ${src('core/timeline-extract.ts')};
import { storedCanonicalTimeline } from ${src('core/persistence/canonical-projections.ts')};
import { pageMentions } from ${src('core/mentions/pass.ts')};
import { buildGazetteer } from ${src('core/by-mention.ts')};
import { readMentionPolicy } from ${src('core/mentions/policy.ts')};
import { planSegmentedExtraction } from ${src('core/extraction-watermark.ts')};
const [file, brain] = process.argv.slice(-2);
const engine = await createEngine({ engine: 'pglite', database_path: brain });
await engine.connect({ engine: 'pglite', database_path: brain });
await engine.initSchema();
await engine.setConfig('pages.segmented_storage', 'on');
const NAMES = ${JSON.stringify(NAMES)};
for (let i = 0; i < 64; i++) await engine.putPage('people/p' + i + '-example', { type: 'person', title: NAMES[i], compiled_truth: 'Fixture.', timeline: '', frontmatter: {} });
const imported = await importFromFile(engine, file, 'notes/memory-example.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) });
const snapshot = await engine.readPageSnapshot('notes/memory-example');
const page = snapshot.page;
const pack = (await loadActivePackForLocalEngine(engine, { sourceId: 'default' }))?.manifest ?? null;
const resolver = makeResolver(engine, { mode: 'live', sourceId: 'default' });
const gazetteer = await buildGazetteer(engine, { policy: await readMentionPolicy(engine), strict: true });
const live = () => { Bun.gc(true); const s = heapStats(); return (s.heapSize + s.extraMemorySize) / 2 ** 20; };
// One read of every segment first: PGLite's WASM memory (counted as extra memory, never returned) reaches its own high water.
for await (const block of bodyBlocks(engine, page)) void block;
const start = live();
let retained = 0, reads = 0;
const read = engine.readSegmentTexts.bind(engine);
engine.readSegmentTexts = async (...args) => {
  const texts = await read(...args);
  if (++reads % 16 === 0) retained = Math.max(retained, live() - start);
  return texts;
};
writeFileSync('/proc/self/clear_refs', '5');
const links = await extractSegmentedPageLinks(engine, { id: Number(page.id), slug: page.slug, source_id: 'default', type: page.type, frontmatter: page.frontmatter },
  resolver, { pack, globalBasename: false, temporal: true });
const canonical = await storedCanonicalTimeline(engine, page, page.slug);
const keys = await segmentedTimelineText(engine, page);
const takes = await parseTakesFenceBlocks(bodyBlocks(engine, page), page);
const mentions = await pageMentions(engine, { id: Number(page.id), slug: page.slug, source_id: 'default', title: page.title, body_storage: 'segmented' }, gazetteer,
  { fromSlug: page.slug, fromSourceId: 'default', allowCrossSource: false });
const plan = await planSegmentedExtraction(engine, Number(page.id), null, { cap: 8000, pipeline: 'facts_backstop', emptyTail: 'skip' });
const peak = Number(/^VmHWM:\\s+(\\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024;
await engine.disconnect();
console.log(JSON.stringify({ status: imported.status, storage: page.body_storage, bytes: Number(page.body_bytes), peak, retained, reads, links: links.candidates.length,
  timeline: canonical.size, entries: keys.entries.length, takes: takes.parsed.takes.length, mentions: mentions.length, plan: plan.mode }));
`;

/** A conversation page of about `mib` MiB with a paragraph linking a distinct person every `mib` MiB / 64, and one dated bullet per paragraph. */
function derivedPage(mib: number): string {
  const parts: string[] = [];
  const step = Math.floor(mib * 2 ** 20 / 64);
  for (let i = 0; i < 64; i++) parts.push(`${conversationBody(step, { seed: 500 + i })}\n\nMet [[people/p${i}-example]] about item ${i}; ${NAMES[i]} agreed.\n\n`);
  const bullets = Array.from({ length: 64 }, (_, i) => `- **2026-0${1 + (i % 9)}-${String(10 + (i % 18)).padStart(2, '0')}** | Item ${i}`).join('\n');
  return `---\ntype: note\ntitle: Memory\n---\n\n${parts.join('')}\n## Timeline\n\n${bullets}\n`;
}

function passesInChild(mib: number) {
  const file = join(dir, `page-${mib}.md`);
  writeFileSync(file, derivedPage(mib));
  const run = spawnSync(process.execPath, ['--no-env-file', '-e', CHILD, file, join(dir, `brain-${mib}`)],
    { cwd: REPO, encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 22 });
  rmSync(file, { force: true });
  const line = run.stdout.trim().split('\n').pop() ?? '';
  if (run.status !== 0 || !line.startsWith('{')) throw new Error(`child passes over ${mib} MiB failed (${run.status}):\n${run.stderr.slice(-3000)}`);
  return JSON.parse(line) as { status: string; storage: string; bytes: number; peak: number; retained: number; reads: number; links: number; timeline: number; entries: number; takes: number; mentions: number; plan: string };
}

describe.skipIf(!existsSync('/proc/self/status'))('segmented derived passes memory', () => {
  test(`every streamed pass over a 40 MiB page peaks under ${PEAK_DELTA_LIMIT_MIB} MiB above the same passes over a 4 MiB page`, () => {
    const small = passesInChild(4);
    const large = passesInChild(40);
    for (const run of [small, large]) {
      expect(run).toMatchObject({ status: 'imported', storage: 'segmented', links: 64, timeline: 64, entries: 64, takes: 0, mentions: 64, plan: 'head' });
    }
    expect(large.bytes).toBeGreaterThan(40 * 2 ** 20 - 2 ** 20);
    console.log(`[segmented-derived-memory] peak 4 MiB ${small.peak.toFixed(0)} MiB, 40 MiB ${large.peak.toFixed(0)} MiB, delta ${(large.peak - small.peak).toFixed(0)} MiB;`
      + ` retained 4 MiB ${small.retained.toFixed(1)} MiB, 40 MiB ${large.retained.toFixed(1)} MiB over ${large.reads} segment reads`);
    expect(large.reads).toBeGreaterThan(small.reads * 5);
    expect(large.retained).toBeLessThan(RETAINED_LIMIT_MIB);
    expect(large.peak - small.peak).toBeLessThan(PEAK_DELTA_LIMIT_MIB);
  }, 1_200_000);
});
