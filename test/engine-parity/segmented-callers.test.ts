/**
 * BrainEngine parity — the two segmented callers end to end: the streamed import of a large Markdown file
 * (`importStreamedMarkdownFile`) and the re-chunk of a page sealed at an older segmented chunker (`runSegmentedRechunk`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a segmented create (sealed at commit), a replace that keeps some occurrences and retires others, a create
 *    over SEGMENTED_CREATE_SEAL_MAX_BYTES (unsealed at commit, so the projection builds its chunks), and an applied
 *    re-chunk that flips a generation all give the same page, chunks and receipts on every arm (PGLite always; Postgres
 *    with DATABASE_URL; Rust with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that refuses one statement of the staging path, the generation flip, the projection or the
 *    re-chunk flip (the Rust engine has no SQL dialect, so each statement must be a typed member) stops a segmented
 *    import or re-chunk on that engine; a member that answers differently leaves different chunks or receipts.
 *  - Why existing coverage misses it: test/engine-parity/segmented-body.test.ts compares the staging members one by
 *    one; test/large-pages/ runs these callers on PGLite only and test/e2e/ on Postgres only, never compared.
 *  - Seam: none in the callers. The "sealed at an older chunker" fixture is built with typed members
 *    (readManifest, readSegmentTexts, deleteChunks, stageSegmentChunks, sealSegmentedPage, setChunkerVersion), as
 *    test/helpers/rechunk-segmented-cases.ts builds it with SQL. Page and occurrence ids are never compared.
 */
import { afterAll, describe, expect } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { readPageBodyPolicy, SEGMENTED_CREATE_SEAL_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { importStreamedMarkdownFile } from '../../src/core/page-body/streamed-import.ts';
import { runSegmentedRechunk } from '../../src/core/page-body/rechunk.ts';
import { SEGMENTED_CHUNKER_VERSION } from '../../src/core/page-body/segment-chunks.ts';
import { chunkProjectedText } from '../../src/core/chunkers/recursive.ts';
import { resolveMaxChunkTokens } from '../../src/core/embedding-input-limit.ts';
import type { SegmentChunkInput } from '../../src/core/page-body/types.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { needleChat, N14_REDUCED } from '../helpers/needle-chat.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const dir = mkdtempSync(join(tmpdir(), 'gbrain-parity-segmented-callers-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Write `body` under frontmatter to a file named for `slug` and import it through the streamed segmented path. */
async function streamed(engine: BrainEngine, backend: string, slug: string, body: string) {
  const file = join(dir, `${backend}-${slug.replaceAll('/', '-')}.md`);
  writeFileSync(file, `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n`);
  const result = await importStreamedMarkdownFile(engine, file, `${slug}.md`, { noEmbed: true }, statSync(file), await readPageBodyPolicy(engine));
  const { slug: resultSlug, status, chunks, error, searchable, projection } = result;
  return { slug: resultSlug, status, chunks, error: error ?? null, searchable: searchable ?? null, projection: projection ?? null };
}

/** The page and its visible chunks as a reader sees them; ids are left out. */
async function pageView(engine: BrainEngine, slug: string) {
  const page = await engine.getPage(slug);
  const chunks = await engine.getChunks(slug);
  return {
    title: page?.title ?? null, type: page?.type ?? null, content_hash: page?.content_hash ?? null,
    chunks: chunks.length, chunk_texts: sha(chunks.map(c => `${c.chunk_source}\0${c.chunk_text}`).join('\n')),
  };
}

const dayOf = (n: number) => new Date(Date.UTC(2018, 11, 29 + n)).toISOString().slice(0, 10);
/** test/helpers/rechunk-segmented-cases.ts's needle page, smaller: the needle day first, then filler days. */
function needleBody(bytes: number): string {
  let body = N14_REDUCED;
  for (let d = 1; Buffer.byteLength(body) < bytes; d++) body += '\n' + needleChat(100 + d, 400, -1, dayOf(d));
  return body;
}

/** Store the page's chunks as the version-4 segmented chunker made them, through typed members only. */
async function sealAtOldChunker(engine: BrainEngine, slug: string): Promise<void> {
  const page = (await engine.getPage(slug))!;
  const head = (await engine.readSegmentedPageHead(page.id))!;
  const rows = await engine.readManifest(page.id);
  const texts = await engine.readSegmentTexts('default', rows.map(row => row.sha256));
  const chunks: SegmentChunkInput[] = [];
  for (const row of rows) {
    const text = new TextDecoder().decode(texts.get(Buffer.from(row.sha256).toString('hex'))!);
    chunkProjectedText(text, { maxTokens: resolveMaxChunkTokens(), spans: true, headingsLead: true }).forEach((c, i) => chunks.push({
      chunk_text: c.text, chunk_source: row.region === 'truth' ? 'compiled_truth' : 'timeline', occurrence_id: Number(row.occurrenceId), local_ordinal: i,
      projected_byte_start: c.byte_start, projected_byte_end: c.byte_end, raw_byte_start: c.byte_start!, raw_byte_end: c.byte_end! }));
  }
  await engine.deleteChunks(slug, { sourceId: 'default' });
  await engine.stageSegmentChunks(page.id, Number(head.body_generation), chunks);
  // deleteChunks unseals the page; the old chunker's rows are its whole projection, so seal it again.
  await engine.sealSegmentedPage(page.id);
  await engine.setChunkerVersion(slug, 4, { sourceId: 'default' });
}

const receiptView = (r: Awaited<ReturnType<typeof runSegmentedRechunk>>) => ({
  dry_run: r.dry_run, chunker_version: r.chunker_version, commands: r.commands,
  pages: r.pages.map(p => ({ ...p })),
});

describe('engine parity: segmented callers', () => {
  parityTest('a streamed segmented import creates a sealed page, replaces it and creates a page over the seal limit whose projection builds its chunks',
    { methods: ['setConfig', 'getPage', 'getChunks'], timeout: 600_000 }, async (engine, backend) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const first = conversationBody(256 * 1024, { seed: 5 });
      const created = await streamed(engine, backend, 'notes/streamed', first);
      expect(created.status).toBe('imported');
      const afterCreate = await pageView(engine, 'notes/streamed');
      // Keep the first half of the days, rewrite the rest: some occurrences stay, some retire.
      const replaced = await streamed(engine, backend, 'notes/streamed', first.slice(0, first.length / 2) + conversationBody(128 * 1024, { seed: 6 }));
      expect(replaced.status).toBe('imported');
      const afterReplace = await pageView(engine, 'notes/streamed');
      expect(afterReplace.content_hash).not.toBe(afterCreate.content_hash);
      const big = await streamed(engine, backend, 'notes/streamed-big', conversationBody(SEGMENTED_CREATE_SEAL_MAX_BYTES + 256 * 1024, { seed: 7 }));
      expect(big.status).toBe('imported');
      const afterBig = await pageView(engine, 'notes/streamed-big');
      expect(afterBig.chunks).toBeGreaterThan(0);
      return { created, afterCreate, replaced, afterReplace, big, afterBig };
    });

  parityTest('an applied segmented re-chunk flips the changed occurrences of a page sealed at an older chunker and stamps the current version',
    { methods: ['setConfig', 'getPage', 'getChunks', 'readSegmentedPageHead', 'readManifest', 'readSegmentTexts', 'deleteChunks',
      'stageSegmentChunks', 'sealSegmentedPage', 'setChunkerVersion'], timeout: 600_000 },
    async (engine, backend) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      expect((await streamed(engine, backend, 'chats/rechunk', needleBody(200_000))).status).toBe('imported');
      await sealAtOldChunker(engine, 'chats/rechunk');
      const sealed = await pageView(engine, 'chats/rechunk');
      const preview = receiptView(await runSegmentedRechunk(engine, { slug: 'chats/rechunk' }));
      expect(preview.pages.map(p => [p.slug, p.chunker_version])).toEqual([['chats/rechunk', 4]]);
      const applied = receiptView(await runSegmentedRechunk(engine, { apply: true, slug: 'chats/rechunk' }));
      expect(applied.pages.map(p => p.state)).toEqual(['rechunked']);
      const after = await pageView(engine, 'chats/rechunk');
      expect(after.content_hash).toBe(sealed.content_hash);
      const again = receiptView(await runSegmentedRechunk(engine, { slug: 'chats/rechunk' }));
      expect(again.pages).toEqual([]);
      return { sealed, preview, applied, after, again, version: SEGMENTED_CHUNKER_VERSION };
    });
});
