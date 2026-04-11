import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEmbed } from '../src/commands/embed.ts';
import { getEmbeddingProvider, resetEmbeddingProviderForTests, setEmbeddingProviderForTests } from '../src/core/embedding.ts';
import { importFile } from '../src/core/import-file.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

let tempDir = '';
let dbPath = '';
let engine: SQLiteEngine;

function createFakeProvider() {
  const batches: string[][] = [];
  return {
    batches,
    provider: {
      capability: {
        available: true,
        mode: 'local' as const,
        implementation: 'test-local',
        model: 'test-local-v1',
        dimensions: 3,
      },
      embedBatch: async (texts: string[]) => {
        batches.push([...texts]);
        return texts.map((text, index) => new Float32Array([text.length, index + 1, texts.length]));
      },
    },
  };
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'gbrain-local-offline-'));
  dbPath = join(tempDir, 'brain.db');
  engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: dbPath });
  await engine.initSchema();
});

afterEach(async () => {
  resetEmbeddingProviderForTests();
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('local/offline embedding flow', () => {
  test('embedding provider none stays unavailable even if OPENAI_API_KEY is set', () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    try {
      const provider = getEmbeddingProvider({
        config: {
          engine: 'postgres',
          database_url: 'postgres://example',
          offline: false,
          embedding_provider: 'none',
          query_rewrite_provider: 'none',
        },
      });

      expect(provider.capability.available).toBe(false);
      expect(provider.capability.mode).toBe('none');
      expect(provider.capability.implementation).toBe('none');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  test('local provider stays unavailable without a configured local runtime', () => {
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousLocalUrl = process.env.GBRAIN_LOCAL_EMBEDDING_URL;
    const previousOllama = process.env.OLLAMA_HOST;

    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.GBRAIN_LOCAL_EMBEDDING_URL;
    delete process.env.OLLAMA_HOST;

    try {
      const provider = getEmbeddingProvider({
        config: {
          engine: 'sqlite',
          database_path: join(tempDir, 'brain.db'),
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'heuristic',
        },
      });

      expect(provider.capability.available).toBe(false);
      expect(provider.capability.mode).toBe('local');
      expect(provider.capability.implementation).toBe('none');
    } finally {
      if (previousOpenAI === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAI;
      }

      if (previousLocalUrl === undefined) {
        delete process.env.GBRAIN_LOCAL_EMBEDDING_URL;
      } else {
        process.env.GBRAIN_LOCAL_EMBEDDING_URL = previousLocalUrl;
      }

      if (previousOllama === undefined) {
        delete process.env.OLLAMA_HOST;
      } else {
        process.env.OLLAMA_HOST = previousOllama;
      }
    }
  });

  test('deferred re-import marks rewritten chunks as missing embeddings', async () => {
    const firstProvider = createFakeProvider();
    setEmbeddingProviderForTests(firstProvider.provider);

    const filePath = join(tempDir, 'rewritten.md');
    writeFileSync(filePath, `---
type: concept
title: Rewritten
---

Original chunk content for the page.
`);

    await importFile(engine, filePath, 'concepts/rewritten.md');
    await runEmbed(engine, ['concepts/rewritten']);

    const embeddedBeforeRewrite = await engine.getChunks('concepts/rewritten');
    expect(embeddedBeforeRewrite.every(chunk => chunk.embedded_at instanceof Date)).toBe(true);

    writeFileSync(filePath, `---
type: concept
title: Rewritten
---

Updated chunk content for the same page.
`);

    const secondImport = await importFile(engine, filePath, 'concepts/rewritten.md');
    expect(secondImport.status).toBe('imported');

    const chunksAfterRewrite = await engine.getChunks('concepts/rewritten');
    expect(chunksAfterRewrite).toHaveLength(1);
    expect(chunksAfterRewrite[0].chunk_text).toContain('Updated chunk content');
    expect(chunksAfterRewrite[0].embedded_at).toBeNull();
    expect(chunksAfterRewrite[0].model).toBe('text-embedding-3-large');
  });

  test('stale-only embedding updates only missing chunks', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);

    await engine.putPage('concepts/stale-only', {
      type: 'concept',
      title: 'Stale Only',
      compiled_truth: 'already embedded\nneeds embedding',
      timeline: 'still missing',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/stale-only', [
      {
        chunk_index: 0,
        chunk_text: 'already embedded',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([9, 9, 9]),
        model: 'seed-model',
        token_count: 3,
      },
      {
        chunk_index: 1,
        chunk_text: 'needs embedding',
        chunk_source: 'compiled_truth',
      },
      {
        chunk_index: 2,
        chunk_text: 'still missing',
        chunk_source: 'timeline',
      },
    ]);

    const before = await engine.getChunks('concepts/stale-only');
    const originalEmbeddedAt = before[0].embedded_at?.toISOString();

    await runEmbed(engine, ['--stale']);

    expect(fake.batches).toEqual([['needs embedding', 'still missing']]);

    const after = await engine.getChunks('concepts/stale-only');
    expect(after[0].model).toBe('seed-model');
    expect(after[0].embedded_at?.toISOString()).toBe(originalEmbeddedAt);
    expect(after[1].embedded_at).toBeInstanceOf(Date);
    expect(after[1].model).toBe('test-local-v1');
    expect(after[2].embedded_at).toBeInstanceOf(Date);
    expect(after[2].model).toBe('test-local-v1');
  });

  test('unchanged content does not trigger re-embedding', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);

    const filePath = join(tempDir, 'unchanged.md');
    writeFileSync(filePath, `---
type: concept
title: Unchanged
---

This page should only be embedded during explicit backfill.
`);

    const first = await importFile(engine, filePath, 'concepts/unchanged.md');
    expect(first.status).toBe('imported');
    expect(fake.batches).toEqual([]);

    await runEmbed(engine, ['concepts/unchanged']);
    expect(fake.batches).toHaveLength(1);

    const before = await engine.getChunks('concepts/unchanged');
    const second = await importFile(engine, filePath, 'concepts/unchanged.md');
    const after = await engine.getChunks('concepts/unchanged');

    expect(second.status).toBe('skipped');
    expect(fake.batches).toHaveLength(1);
    expect(after.map(chunk => chunk.model)).toEqual(before.map(chunk => chunk.model));
    expect(after.map(chunk => chunk.embedded_at?.toISOString())).toEqual(
      before.map(chunk => chunk.embedded_at?.toISOString()),
    );
  });

  test('page-level explicit embed rebuilds already-embedded chunks', async () => {
    const firstProvider = createFakeProvider();
    setEmbeddingProviderForTests(firstProvider.provider);

    const filePath = join(tempDir, 'page-rebuild.md');
    writeFileSync(filePath, `---
type: concept
title: Page Rebuild
---

First chunk sentence.

---

Timeline sentence.
`);

    await importFile(engine, filePath, 'concepts/page-rebuild.md');
    await runEmbed(engine, ['concepts/page-rebuild']);

    const initialChunks = await engine.getChunks('concepts/page-rebuild');
    expect(initialChunks.every(chunk => chunk.model === 'test-local-v1')).toBe(true);

    const rebuildBatches: string[][] = [];
    setEmbeddingProviderForTests({
      capability: {
        available: true,
        mode: 'local',
        implementation: 'test-local',
        model: 'test-local-v2',
        dimensions: 3,
      },
      embedBatch: async (texts: string[]) => {
        rebuildBatches.push([...texts]);
        return texts.map((text, index) => new Float32Array([text.length, index + 10, 2]));
      },
    });

    await runEmbed(engine, ['concepts/page-rebuild']);

    expect(rebuildBatches).toEqual([initialChunks.map(chunk => chunk.chunk_text)]);

    const rebuiltChunks = await engine.getChunks('concepts/page-rebuild');
    expect(rebuiltChunks.every(chunk => chunk.model === 'test-local-v2')).toBe(true);
    expect(rebuiltChunks.every(chunk => chunk.embedded_at instanceof Date)).toBe(true);
  });
});
