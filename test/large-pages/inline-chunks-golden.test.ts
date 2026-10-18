/**
 * Wave B inline golden: pages at or under 1 MiB keep master's bytes exactly.
 *
 * 1. Protects: the inline storage path while segmented storage ships. For a
 *    seeded corpus of <= 1 MiB pages (fences, facts/takes, timeline, CRLF,
 *    long lines, CJK, the threshold itself) the chunker output, and the page
 *    and chunk rows an import writes, hash to the digests captured on master
 *    44eb0493f, with `pages.segmented_storage` off and on.
 * 2. Fails when: any Wave B change alters inline chunking, the stored body
 *    columns, content_hash, chunker_version or chunk rows of a page that
 *    never crosses the inline threshold.
 * 3. Regenerate only for an intended inline change:
 *    GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/large-pages/inline-chunks-golden.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { prepareMarkdownChunks } from '../../src/core/markdown-chunks.ts';
import { PAGE_INLINE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { inlinePageCorpus } from '../helpers/inline-page-corpus.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'large-pages', 'inline-chunks-golden.json');
const UPDATE = process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1';
const corpus = inlinePageCorpus();
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

interface Golden { chunker: Record<string, string>; rows: Record<string, string>; bodyBytes: Record<string, number> }
const golden: Golden = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf-8')) : { chunker: {}, rows: {}, bodyBytes: {} };
const observed: Golden = { chunker: {}, rows: {}, bodyBytes: {} };

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  if (UPDATE) writeFileSync(FIXTURE, JSON.stringify(observed, null, 2) + '\n');
});

async function storedRows(slug: string) {
  const [page] = await engine.executeRaw<Record<string, unknown>>(
    'SELECT slug, type, title, compiled_truth, timeline, frontmatter, content_hash, chunker_version, page_kind FROM pages WHERE slug = $1', [slug]);
  const chunks = await engine.executeRaw<Record<string, unknown>>(
    `SELECT c.chunk_index, c.chunk_text, c.chunk_source, c.language, c.symbol_name, c.symbol_type, c.start_line, c.end_line,
            c.projected_byte_start, c.projected_byte_end
       FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 ORDER BY c.chunk_index`, [slug]);
  return { page, chunks: chunks.map(c => ({ ...c, start_line: c.start_line ?? null, end_line: c.end_line ?? null })) };
}

describe('inline pages stay byte-identical to master', () => {
  test('the corpus spans the inline range up to the threshold', () => {
    const sizes = corpus.map(p => { const m = parseMarkdown(p.content, `${p.slug}.md`); return Buffer.byteLength(m.compiled_truth) + Buffer.byteLength(m.timeline); });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PAGE_INLINE_MAX_BYTES);
    expect(Math.max(...sizes)).toBeGreaterThan(PAGE_INLINE_MAX_BYTES - 16 * 1024);
  });

  for (const page of corpus) {
    test(`chunker output: ${page.slug}`, async () => {
      const parsed = parseMarkdown(page.content, `${page.slug}.md`);
      observed.bodyBytes[page.slug] = Buffer.byteLength(parsed.compiled_truth) + Buffer.byteLength(parsed.timeline);
      observed.chunker[page.slug] = sha(await prepareMarkdownChunks(parsed));
      if (!UPDATE) {
        expect(observed.bodyBytes[page.slug]).toBe(golden.bodyBytes[page.slug]);
        expect(observed.chunker[page.slug]).toBe(golden.chunker[page.slug]);
      }
    }, 60_000);
  }

  for (const mode of ['off', 'on'] as const) {
    describe(`import with pages.segmented_storage=${mode}`, () => {
      beforeAll(async () => {
        await engine.executeRaw('DELETE FROM pages');
        await engine.setConfig('pages.segmented_storage', mode);
      });
      for (const page of corpus) {
        test(`stored rows: ${page.slug}`, async () => {
          const result = await importFromContent(engine, page.slug, page.content, { sourceId: 'default', noEmbed: true });
          expect(result.status).toBe('imported');
          const digest = sha(await storedRows(page.slug));
          if (mode === 'off') observed.rows[page.slug] = digest;
          if (!UPDATE || mode === 'on') expect(digest).toBe(UPDATE ? observed.rows[page.slug] : golden.rows[page.slug]);
        }, 60_000);
      }
    });
  }
});
