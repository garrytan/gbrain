/**
 * BrainEngine parity — the two segmented callers end to end: the streamed import of a large Markdown file
 * (`importStreamedMarkdownFile`) and the re-chunk of a page sealed at an older segmented chunker (`runSegmentedRechunk`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a segmented create (sealed at commit), a replace that keeps some occurrences and retires others, a create
 *    over SEGMENTED_CREATE_SEAL_MAX_BYTES (unsealed at commit, so the projection builds its chunks), an applied
 *    re-chunk that flips a generation, and an incremental link derivation that stores its runs and then reuses them
 *    all give the same page, chunks, links, derivation rows and receipts on every arm (PGLite always; Postgres
 *    with DATABASE_URL; Rust with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that refuses one statement of the staging path, the generation flip, the projection or the
 *    re-chunk flip (the Rust engine has no SQL dialect, so each statement must be a typed member) stops a segmented
 *    import or re-chunk on that engine; a member that answers differently leaves different chunks or receipts. The
 *    derivation driver's guarded store (storeSegmentDerivationsIfLive) ran as raw SQL, so the Rust arm refused it.
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
import { openSegmentedLinkSession } from '../../src/core/page-body/segment-links.ts';
import { segmentDeriveWork } from '../../src/core/page-body/segment-derive.ts';
import { makeResolver } from '../../src/core/link-extraction.ts';
import { SEGMENTED_CHUNKER_VERSION } from '../../src/core/page-body/segment-chunks.ts';
import { chunkProjectedText } from '../../src/core/chunkers/recursive.ts';
import { resolveMaxChunkTokens } from '../../src/core/embedding-input-limit.ts';
import type { SegmentChunkInput } from '../../src/core/page-body/types.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { needleChat, N14_REDUCED } from '../helpers/needle-chat.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
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
    { methods: ['setConfig', 'getPage', 'getChunks', 'lockBodyStagingState', 'deleteUnstagedSegmentChunks', 'readSegmentedLivePage',
      'readSegmentedPageSealed', 'listChunkedOccurrences', 'readRetiredChunkVectors', 'hasStaleSegmentChunks', 'retireStaleSegmentChunks',
      'readSegmentedProjectionPage'], timeout: 600_000 }, async (engine, backend) => {
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
      'stageSegmentChunks', 'sealSegmentedPage', 'setChunkerVersion', 'listSegmentedRechunkCandidates', 'readSegmentedRechunkPage',
      'listOccurrenceChunks', 'readMaterializingRevision', 'setMaterializingRevision', 'restorePageUpdatedAt', 'readPageTrustRows'], timeout: 600_000 },
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

  parityTest('a get_page window read whose page a re-chunk flipped after the read was authorized answers revision_changed',
    { methods: ['setConfig', 'getPage', 'readPageSnapshot', 'readSegmentedPageHead', 'setMaterializingRevision'], timeout: 600_000 },
    async (engine, backend) => {
      // A re-chunk keeps the knowledge revision (the body did not change) and publishes a new body generation, so only
      // the generation of the read pin (the get_page snapshot's bodyGeneration) tells the reader that the rows it was
      // authorized for are gone. The race is forced as test/large-pages/pinned-segmented-reads.test.ts forces it: a
      // one-shot hook runs the re-chunk before the window read opens the page row; no timing.
      await engine.setConfig('pages.segmented_storage', 'on');
      expect((await streamed(engine, backend, 'chats/pinned', needleBody(200_000))).status).toBe('imported');
      await sealAtOldChunker(engine, 'chats/pinned');
      const before = (await engine.readPageSnapshot('chats/pinned', { sourceId: 'default' }))!;
      const states: string[] = [];
      const head = engine.readSegmentedPageHead;
      // A transaction's engine may inherit from `engine`, so the hook keeps the caller's `this`.
      engine.readSegmentedPageHead = (async function (this: BrainEngine, ...args: Parameters<BrainEngine['readSegmentedPageHead']>) {
        if (!states.length) {
          states.push('fired');
          states.push(...(await runSegmentedRechunk(engine, { apply: true, slug: 'chats/pinned' })).pages.map(p => String(p.state)));
        }
        return head.apply(this, args);
      }) as BrainEngine['readSegmentedPageHead'];
      let out;
      try {
        out = await dispatchToolCall(engine, 'get_page', { slug: 'chats/pinned', body: 'window', bytes: { offset: 0, length: 400 } },
          { remote: false, admissionOrigin: 'interactive', transport: 'stdio', sourceId: 'default' } as never);
      } finally {
        engine.readSegmentedPageHead = head;
      }
      const answer = JSON.parse((out as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
      const after = (await engine.readPageSnapshot('chats/pinned', { sourceId: 'default' }))!;
      const result = {
        rechunked: states,
        revisionKept: after.revision === before.revision,
        generationMoved: Number(after.bodyGeneration) > Number(before.bodyGeneration),
        code: answer.code ?? null,
        windowReturned: answer.window !== undefined,
      };
      expect(result).toEqual({ rechunked: ['fired', 'rechunked'], revisionKept: true, generationMoved: true, code: 'revision_changed', windowReturned: false });
      return result;
    });

  parityTest('an incremental link derivation stores a row per live occurrence, then reuses every run on a second pass',
    { methods: ['setConfig', 'getPage', 'readSegmentedPageHead', 'readManifest', 'readSegmentDerivations', 'storeSegmentDerivationsIfLive',
      'readPageSnapshot'], timeout: 600_000 }, async (engine, backend) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const days = conversationBody(256 * 1024, { seed: 8 }).split('\n\n');
      const body = days.map((day, i) => i % 40 === 0 ? `${day}\n\nMet [[people/alice-example]] and [[companies/acme-example]] about item ${i}.` : day).join('\n\n');
      expect((await streamed(engine, backend, 'notes/derived', body)).status).toBe('imported');
      const page = (await engine.getPage('notes/derived'))!;
      const target = { id: page.id, slug: 'notes/derived', source_id: 'default', type: page.type, frontmatter: page.frontmatter ?? {}, title: page.title };
      const opts = { globalBasename: false, lineGrammar: { enabled: true, allowUndeclaredTypes: false } };
      const pass = async () => {
        for (const work of Object.values(segmentDeriveWork)) Object.assign(work, { derived: 0, occurrences: 0, reused: 0, skipped: 0, reread: 0 });
        const session = await openSegmentedLinkSession(engine, target as never, makeResolver(engine, { mode: 'live', sourceId: 'default' }), opts);
        expect(session).not.toBeNull();
        await session!.targets(opts);
        const result = await session!.finish({ ...opts, temporal: true, targetType: () => undefined } as never);
        const { derived, occurrences, skipped } = segmentDeriveWork.links;
        return { targets: result.candidates.map(c => `${c.targetSlug}:${c.linkType}`).sort(), derived, occurrences, skipped };
      };
      const first = await pass();
      expect(first.derived).toBeGreaterThan(0);
      expect(first.skipped).toBe(0);
      const rows = await engine.readSegmentDerivations(page.id, { kind: 'links' });
      const live = (await engine.readManifest(page.id)).map(row => Number(row.occurrenceId)).sort((a, b) => a - b);
      expect(rows.map(row => row.occurrenceId).sort((a, b) => a - b)).toEqual(live);
      const second = await pass();
      expect([second.derived, second.skipped]).toEqual([0, 0]);
      expect(second.targets).toEqual(first.targets);
      return { first, second, rows: rows.map(row => ({ state: row.state, version: row.version, sha: Buffer.from(row.segmentSha256).toString('hex') })).sort((a, b) => a.sha.localeCompare(b.sha)) };
    });
});
