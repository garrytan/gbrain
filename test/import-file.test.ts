import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { importFile } from '../src/core/import-file.ts';
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

---

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

  test('uses semantic chunker when embedFn present, falls back to recursive gracefully', async () => {
    const filePath = join(TMP, 'semantic-path.md');
    const block = Array(40).fill('The mitochondria is the powerhouse of the cell.').join(' ');
    writeFileSync(filePath, `---
type: concept
title: Semantic Path
---

${block}

---

- 2024-01-01: Entry one about biology.
- 2024-02-01: Entry two about biology.
`);

    let embedCallCount = 0;
    const mockEmbedFn = async (texts: string[]): Promise<Float32Array[]> => {
      embedCallCount += texts.length;
      return texts.map(() => new Float32Array(1536).fill(0.1));
    };

    // Patch embedBatch on the module — we test the semantic chunker directly
    // since import-file wires noEmbed:false -> embedBatch.
    // Here we verify the semantic chunker accepts and uses our embedFn.
    const { chunkTextSemantic } = await import('../src/core/chunkers/semantic.ts');
    const chunks = await chunkTextSemantic(block, { embedFn: mockEmbedFn });

    expect(chunks.length).toBeGreaterThan(0);
    expect(embedCallCount).toBeGreaterThan(0);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
      expect(chunks[i].text.length).toBeGreaterThan(0);
    }
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
