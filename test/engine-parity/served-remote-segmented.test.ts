/**
 * BrainEngine parity: the reads a remote get_versions, get_page, search and search_exact make for a page stored in
 * segments and for the literal-phrase scan, called over MCP stdio (dispatchToolCall with remote: true).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded, multi-user or served) a remote
 *    caller's get_versions of a segmented page after a second import, its get_page of a hidden one, its search over
 *    segmented pages and its search_exact answer the readable pages the same, through these typed members:
 *    readSegmentedPageHead and readSegmentedVersionBodyBytes (get_versions, through the body tiling check),
 *    scanExactBatch (search_exact) and readSegmentRegions (search's region read when a segmented page has more than two
 *    chunk hits; Rust only, the other engines answer it with SQL). The seed holds a private page (segmented and plain)
 *    and a readers-only page with their own markers; no answer to the remote caller carries a marker, and a private
 *    page asked for by slug is refused.
 *  - Regression: a served client of a brain server refused one of these members with a typed refusal while the remote
 *    operation that reaches it was served, so the page, the version list or the scan stopped; a member that answered
 *    a hidden page would show the marker here.
 *  - Why existing coverage misses it: the member parity files call each member directly, never through the remote
 *    operation, and the served set had no case with a segmented page or a literal-phrase scan.
 *  - Seam: none. Segmented pages go through the streamed import (importStreamedMarkdownFile), the plain pages through
 *    putPage and sealChunks; the operations run as production code.
 */
import { afterAll, expect } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { chunk } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { importStreamedMarkdownFile } from '../../src/core/page-body/streamed-import.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { withRemoteCaller } from '../../src/core/remote-caller.ts';
import { remote, remoteView } from '../helpers/served-remote-brain.ts';

const { parityTest } = parityArms(testBackends());

const dir = mkdtempSync(join(tmpdir(), 'gbrain-parity-served-segmented-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NEEDLE = 'zqexactneedle';

/** Import `body` as a segmented page through the streamed path; `frontmatter` lines go under the type and title. */
async function streamed(engine: BrainEngine, backend: string, slug: string, body: string, frontmatter: string[] = []): Promise<string> {
  const file = join(dir, `${backend}-${slug.replaceAll('/', '-')}-${Date.now()}.md`);
  writeFileSync(file, `---\ntype: note\ntitle: ${slug}\n${frontmatter.map(l => `${l}\n`).join('')}---\n\n${body}\n`);
  const result = await importStreamedMarkdownFile(engine, file, `${slug}.md`, { noEmbed: true }, statSync(file), await readPageBodyPolicy(engine));
  return result.status;
}

async function plain(engine: BrainEngine, slug: string, body: string, frontmatter: Record<string, unknown> = {}): Promise<void> {
  await engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: body, timeline: '', frontmatter });
  await engine.sealChunks(slug, [chunk(0, body)]);
}

parityTest('a remote get_versions reads the versions of a segmented page, and a private segmented page stays hidden', {
  methods: ['setConfig', 'readSegmentedPageHead', 'readSegmentedVersionBodyBytes'],
  timeout: 600_000,
}, async (engine: BrainEngine, backend: string) => {
  await engine.setConfig('pages.segmented_storage', 'on');
  expect(await streamed(engine, backend, 'notes/seg-open', `Open segmented page.\n${conversationBody(256 * 1024, { seed: 5 })}`)).toBe('imported');
  expect(await streamed(engine, backend, 'notes/seg-secret', `zqprivmark private segmented page.\n${conversationBody(256 * 1024, { seed: 6 })}`, ['visibility: private'])).toBe('imported');
  // A second import of the open page leaves its first generation as a version.
  expect(await streamed(engine, backend, 'notes/seg-open', `Open segmented page, second generation.\n${conversationBody(256 * 1024, { seed: 7 })}`)).toBe('imported');
  // get_page of the open segmented page is not asked here: its read view caches a line count per revision in the
  // page-view digest (readPageViewDigest, a write when it is missing), which a served remote caller cannot do yet.
  const answer = {
    secret: await remoteView(engine, 'get_page', { slug: 'notes/seg-secret', body: 'auto' }),
    openVersions: await remoteView(engine, 'get_versions', { slug: 'notes/seg-open' }),
    secretVersions: await remoteView(engine, 'get_versions', { slug: 'notes/seg-secret' }),
  };
  expect(answer.openVersions.isError).toBe(false);
  expect(answer.secret.isError).toBe(true);
  // The open page's first generation is a version; the private page's list is empty or refused, never its text.
  expect((await remote(engine, 'get_versions', { slug: 'notes/seg-open' })).text).toContain('snapshot_at');
  expect((await remote(engine, 'get_versions', { slug: 'notes/seg-secret' })).text).not.toContain('snapshot_at');
  for (const view of Object.values(answer)) expect(view.leaked).toEqual([]);
  return answer;
});

parityTest('a remote search_exact scans the readable pages for a phrase and never shows a hidden one', {
  methods: ['putPage', 'sealChunks', 'scanExactBatch'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await plain(engine, 'notes/exact-open', `The phrase ${NEEDLE} sits in an open page.`);
  await plain(engine, 'notes/exact-secret', `The phrase ${NEEDLE} sits in a private page. zqprivmark.`, { visibility: 'private' });
  await plain(engine, 'notes/exact-readers', `The phrase ${NEEDLE} sits in a readers-only page. zqreadersmark.`, { readable_by: ['alice-example'] });
  const answer = { scan: await remoteView(engine, 'search_exact', { phrase: NEEDLE }) };
  expect(answer.scan.isError).toBe(false);
  expect(answer.scan.slugs).toEqual(['notes/exact-open']);
  expect(answer.scan.leaked).toEqual([]);
  return answer;
});

parityTest('a remote search for a phrase in segmented pages answers the readable one only', {
  methods: ['setConfig'],
  timeout: 600_000,
}, async (engine: BrainEngine, backend: string) => {
  await engine.setConfig('pages.segmented_storage', 'on');
  expect(await streamed(engine, backend, 'notes/seg-hits', `Many hits ${NEEDLE}.\n${conversationBody(256 * 1024, { seed: 8, needles: [0.1, 0.3, 0.5, 0.7, 0.9].map(at => ({ at, word: NEEDLE })) })}`)).toBe('imported');
  expect(await streamed(engine, backend, 'notes/seg-hits-secret', `zqprivmark ${NEEDLE}.\n${conversationBody(256 * 1024, { seed: 9, needles: [0.1, 0.3, 0.5, 0.7, 0.9].map(at => ({ at, word: NEEDLE })) })}`, ['visibility: private'])).toBe('imported');
  const answer = { search: await remoteView(engine, 'search', { query: NEEDLE }) };
  expect(answer.search.isError).toBe(false);
  expect(answer.search.slugs).toContain('notes/seg-hits');
  expect(answer.search.leaked).toEqual([]);
  expect(answer.search.slugs).not.toContain('notes/seg-hits-secret');
  return answer;
});

// readSegmentRegions is a Rust-store member: the other engines answer search's region read with SQL. Search asks it only
// when a segmented page has more than two chunk hits, which needs a vector arm (an embedding provider), so no remote
// operation reaches it in this file; the case calls it as a remote caller would, with the ids of a page it may read.
parityTest('a remote caller reads the occurrence position of each live chunk of a segmented page', {
  methods: ['setConfig', 'getChunks'],
  timeout: 600_000,
}, async (engine: BrainEngine, backend: string) => {
  await engine.setConfig('pages.segmented_storage', 'on');
  expect(await streamed(engine, backend, 'notes/seg-regions', conversationBody(256 * 1024, { seed: 10 }))).toBe('imported');
  const page = (await engine.getPage('notes/seg-regions'))!;
  const chunks = await engine.getChunks('notes/seg-regions');
  expect(chunks.length).toBeGreaterThan(2);
  if (engine.readSegmentRegions) {
    const rows = await withRemoteCaller(true, () => engine.readSegmentRegions!(chunks.map(c => ({ pageId: Number(page.id), chunkId: Number(c.id) }))));
    expect(rows.length).toBe(chunks.length);
    expect(rows.every(r => Number.isSafeInteger(Number(r.byte_start)))).toBe(true);
  }
  return { chunks: chunks.length };
});
