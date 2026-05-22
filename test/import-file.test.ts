import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { importFile, importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const TMP = join(import.meta.dir, '.tmp-import-test');

// Minimal mock engine that tracks calls and supports transaction()
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };

  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'getTags') return overrides.getTags || (() => Promise.resolve([]));
      if (prop === 'getPage') return overrides.getPage || (() => Promise.resolve(null));
      // transaction: just call the fn with the same engine (no real DB transaction in tests)
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      return track(prop);
    },
  });
  return engine;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('importFile', () => {
  test('imports a valid markdown file', async () => {
    const filePath = join(TMP, 'test-page.md');
    writeFileSync(filePath, `---
type: concept
title: Test Page
tags: [alpha, beta]
---

This is the compiled truth.

---

- 2024-01-01: Something happened.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'concepts/test-page.md', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe('concepts/test-page');
    expect(result.chunks).toBeGreaterThan(0);

    // Verify engine was called correctly
    const calls = (engine as any)._calls;
    const putCall = calls.find((c: any) => c.method === 'putPage');
    expect(putCall).toBeTruthy();
    expect(putCall.args[0]).toBe('concepts/test-page');

    // Tags were added
    const tagCalls = calls.filter((c: any) => c.method === 'addTag');
    expect(tagCalls.length).toBe(2);

    // Chunks were upserted
    const chunkCall = calls.find((c: any) => c.method === 'upsertChunks');
    expect(chunkCall).toBeTruthy();
  });

  test('skips files larger than MAX_FILE_SIZE (5MB)', async () => {
    const filePath = join(TMP, 'big-file.md');
    const bigContent = '---\ntitle: Big\n---\n' + 'x'.repeat(5_100_000);
    writeFileSync(filePath, bigContent);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'big-file.md', { noEmbed: true });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('too large');
    expect((engine as any)._calls.length).toBe(0);
  });

  test('rejects frontmatter slug that does not match the file path', async () => {
    // In a shared brain where contributors can land PRs, this prevents a
    // poisoned notes/random.md from declaring `slug: people/elon` in its
    // frontmatter and overwriting the legitimate people/elon page on sync.
    const filePath = join(TMP, 'hijack.md');
    writeFileSync(filePath, `---
type: person
title: Elon Musk
slug: people/elon
---

Poisoned content that would overwrite people/elon.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'notes/random.md', { noEmbed: true });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('people/elon');
    expect(result.error).toContain('notes/random');
    // No writes to the DB — the hijack never reaches putPage/createVersion.
    expect((engine as any)._calls.length).toBe(0);
  });

  test('accepts frontmatter slug that matches the file path', async () => {
    // Sanity: a legitimate file whose frontmatter slug happens to equal the
    // path-derived slug must still import.
    const filePath = join(TMP, 'alice.md');
    writeFileSync(filePath, `---
type: person
title: Alice
slug: people/alice-smith
---

Legit content.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'people/alice-smith.md', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe('people/alice-smith');
  });

  test('uses path-derived slug when no frontmatter slug is set', async () => {
    // The common case: no frontmatter.slug, so the path determines the slug.
    const filePath = join(TMP, 'concept-path.md');
    writeFileSync(filePath, `---
type: concept
title: From Path
---

Content.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'concepts/from-path.md', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe('concepts/from-path');
  });

  test('skips symlinks in importFromFile (defense-in-depth)', async () => {
    // Even if the walker somehow passes a symlink through, importFromFile
    // should catch it and return skipped.
    const realFile = join(TMP, 'real-target.md');
    writeFileSync(realFile, `---
type: concept
title: Real
---

Content.
`);
    const linkPath = join(TMP, 'symlink-file.md');
    try { rmSync(linkPath); } catch { /* may not exist */ }
    symlinkSync(realFile, linkPath);

    const engine = mockEngine();
    const result = await importFile(engine, linkPath, 'symlink-file.md', { noEmbed: true });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('symlink');
    expect((engine as any)._calls.length).toBe(0);
  });

  test('skips file when content hash matches (idempotent)', async () => {
    const filePath = join(TMP, 'unchanged.md');
    writeFileSync(filePath, `---
type: concept
title: Unchanged
---

Same content.
`);

    // Hash now includes ALL fields (title, type, frontmatter, tags)
    const { createHash } = await import('crypto');
    const { parseMarkdown } = await import('../src/core/markdown.ts');
    const content = `---
type: concept
title: Unchanged
---

Same content.
`;
    const parsed = parseMarkdown(content, 'concepts/unchanged.md');
    const hash = createHash('sha256')
      .update(JSON.stringify({
        title: parsed.title,
        type: parsed.type,
        compiled_truth: parsed.compiled_truth,
        timeline: parsed.timeline,
        frontmatter: parsed.frontmatter,
        tags: parsed.tags.sort(),
      }))
      .digest('hex');

    const engine = mockEngine({
      getPage: () => Promise.resolve({ content_hash: hash }),
    });

    const result = await importFile(engine, filePath, 'concepts/unchanged.md', { noEmbed: true });
    expect(result.status).toBe('skipped');

    const calls = (engine as any)._calls;
    const putCall = calls.find((c: any) => c.method === 'putPage');
    expect(putCall).toBeUndefined();
  });

  test('reconciles tags: removes old, adds new', async () => {
    const filePath = join(TMP, 'retag.md');
    writeFileSync(filePath, `---
type: concept
title: Retagged
tags: [new-tag, kept-tag]
---

Content here.
`);

    const engine = mockEngine({
      getTags: () => Promise.resolve(['old-tag', 'kept-tag']),
      getPage: () => Promise.resolve(null),
    });

    await importFile(engine, filePath, 'concepts/retag.md', { noEmbed: true });

    const calls = (engine as any)._calls;
    const removeCalls = calls.filter((c: any) => c.method === 'removeTag');
    const addCalls = calls.filter((c: any) => c.method === 'addTag');

    expect(removeCalls.length).toBe(1);
    expect(removeCalls[0].args[1]).toBe('old-tag');
    expect(addCalls.length).toBe(2);
  });

  test('chunks compiled_truth and timeline separately', async () => {
    const filePath = join(TMP, 'chunked.md');
    writeFileSync(filePath, `---
type: concept
title: Chunked
---

This is compiled truth content that should be chunked as compiled_truth source.

<!-- timeline -->

- 2024-01-01: This is timeline content that should be chunked as timeline source.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'concepts/chunked.md', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThanOrEqual(2);

    const calls = (engine as any)._calls;
    const chunkCall = calls.find((c: any) => c.method === 'upsertChunks');
    const chunks = chunkCall.args[1];

    const ctChunks = chunks.filter((c: any) => c.chunk_source === 'compiled_truth');
    const tlChunks = chunks.filter((c: any) => c.chunk_source === 'timeline');
    expect(ctChunks.length).toBeGreaterThan(0);
    expect(tlChunks.length).toBeGreaterThan(0);
  });

  test('handles file with minimal content', async () => {
    const filePath = join(TMP, 'minimal.md');
    writeFileSync(filePath, `---
type: concept
title: Minimal
---

One line.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'concepts/minimal.md', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThanOrEqual(1);
  });

  test('skips chunking for empty timeline', async () => {
    const filePath = join(TMP, 'empty-tl.md');
    writeFileSync(filePath, `---
type: concept
title: No Timeline
---

Just compiled truth, no timeline separator.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'concepts/empty-tl.md', { noEmbed: true });

    expect(result.status).toBe('imported');

    const calls = (engine as any)._calls;
    const chunkCall = calls.find((c: any) => c.method === 'upsertChunks');
    if (chunkCall) {
      const chunks = chunkCall.args[1];
      const tlChunks = chunks.filter((c: any) => c.chunk_source === 'timeline');
      expect(tlChunks.length).toBe(0);
    }
  });

  test('noEmbed: true skips embedding', async () => {
    const filePath = join(TMP, 'no-embed.md');
    writeFileSync(filePath, `---
type: concept
title: No Embed
---

Content to chunk but not embed.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'concepts/no-embed.md', { noEmbed: true });

    expect(result.status).toBe('imported');
    const calls = (engine as any)._calls;
    const chunkCall = calls.find((c: any) => c.method === 'upsertChunks');
    if (chunkCall) {
      for (const chunk of chunkCall.args[1]) {
        expect(chunk.embedding).toBeUndefined();
      }
    }
  });

  test('rejects in-memory content larger than MAX_FILE_SIZE', async () => {
    // The remote MCP put_page operation hands user-supplied content straight
    // to importFromContent, which is the path this guard defends. The guard
    // must trigger BEFORE parseMarkdown / chunkText / embedBatch — if it doesn't,
    // an authenticated attacker can force the owner to pay for embedding a
    // multi-megabyte string.
    const bigContent = '---\ntitle: Big\n---\n' + 'x'.repeat(5_100_000);

    const engine = mockEngine();
    const result = await importFromContent(engine, 'big-slug', bigContent, { noEmbed: true });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('too large');
    // No engine work at all — confirms the guard short-circuits before any
    // parsing or chunking allocation.
    expect((engine as any)._calls.length).toBe(0);
  });

  test('uses UTF-8 byte length, not JS string length, for the size check', async () => {
    // 2.6M 4-byte codepoints = ~10.4 MB UTF-8 but only 2.6M JS UTF-16 code units.
    // A length-based check would let this through; a byteLength check catches it.
    const fourByteChar = '\u{1F600}'; // emoji, 4 bytes in UTF-8
    const bigContent = fourByteChar.repeat(2_600_000);

    const engine = mockEngine();
    const result = await importFromContent(engine, 'emoji-slug', bigContent, { noEmbed: true });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('too large');
    expect((engine as any)._calls.length).toBe(0);
  });

  test('accepts in-memory content just under MAX_FILE_SIZE', async () => {
    // Sanity: content exactly at the limit must still import. If this test
    // fails, the guard is off-by-one and will break legitimate large imports.
    const content = '---\ntitle: Borderline\n---\n' + 'x'.repeat(4_900_000);

    const engine = mockEngine();
    const result = await importFromContent(engine, 'borderline-slug', content, { noEmbed: true });

    expect(result.status).toBe('imported');
  });

  test('assigns sequential chunk_index values', async () => {
    const filePath = join(TMP, 'indexed.md');
    const longText = Array(50).fill('This is a sentence that adds length to the content.').join(' ');
    writeFileSync(filePath, `---
type: concept
title: Indexed
---

${longText}

---

${longText}
`);

    const engine = mockEngine();
    await importFile(engine, filePath, 'concepts/indexed.md', { noEmbed: true });

    const calls = (engine as any)._calls;
    const chunkCall = calls.find((c: any) => c.method === 'upsertChunks');
    if (chunkCall) {
      const chunks = chunkCall.args[1];
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].chunk_index).toBe(i);
      }
    }
  });
});
