/**
 * A13: a markdown edit re-embeds only the chunks whose embedding input
 * changed. Unchanged chunks keep their stored vectors when the chunk text,
 * chunk source, contextual wrapper and embedding signature all match and
 * neither the old nor the new body holds protected (facts/takes) fences.
 *
 * PGLite in-memory; the embedding transport is stubbed ($0).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';

const DIMS = 1536;
let engine: PGLiteEngine;
let embedded: string[] = [];
let counter = 0;

function gateway(model = 'openai:text-embedding-3-large') {
  configureGateway({ embedding_model: model, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedded.push(...values);
    return {
      embeddings: values.map(() => { const v = new Array(DIMS).fill(0); v[counter++ % DIMS] = 1; return v; }),
      usage: { tokens: values.length },
    };
  }) as never);
}

beforeAll(async () => {
  resetGateway();
  gateway();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
}, 30_000);

beforeEach(() => { embedded = []; gateway(); });

const paragraph = (word: string) => Array.from({ length: 400 }, (_, i) => `${word}${i}`).join(' ') + '.';
const page = (title: string, words: string[], extra = '') =>
  `---\ntype: note\ntitle: ${title}\n---\n\n${words.map(w => `## Section ${w}\n\n${paragraph(w)}`).join('\n\n')}\n${extra}`;

async function vectors(slug: string) {
  const chunks = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
  return new Map(chunks.map(c => [c.chunk_text, Array.from(c.embedding as Float32Array).indexOf(1)]));
}

describe('markdown import reuses unchanged chunk vectors (A13)', () => {
  test('a one-section edit embeds only the changed chunk and keeps the others byte-identical', async () => {
    const slug = 'notes/reuse-edit';
    await importFromContent(engine, slug, page('Reuse', ['alpha', 'bravo', 'charlie', 'delta']));
    const before = await vectors(slug);
    expect(before.size).toBeGreaterThanOrEqual(3);
    embedded = [];
    await importFromContent(engine, slug, page('Reuse', ['alpha', 'bravo', 'charlie', 'echo']));
    const after = await vectors(slug);
    expect(embedded.length).toBeLessThan(before.size);
    expect(embedded.length).toBeGreaterThan(0);
    for (const text of embedded) expect(text).toContain('echo');
    for (const [text, idx] of after) {
      if (before.has(text)) expect(idx).toBe(before.get(text)!);
      expect(idx).toBeGreaterThanOrEqual(0);
    }
  });

  test('a title change under the title wrapper re-embeds every chunk', async () => {
    await engine.setConfig('search.contextual_retrieval', 'title');
    try {
      const slug = 'notes/reuse-title';
      await importFromContent(engine, slug, page('First title', ['alpha', 'bravo', 'charlie']));
      const count = (await vectors(slug)).size;
      embedded = [];
      await importFromContent(engine, slug, page('Second title', ['alpha', 'bravo', 'charlie']));
      expect(embedded.length).toBe(count);
    } finally {
      await engine.unsetConfig?.('search.contextual_retrieval');
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.contextual_retrieval'`);
    }
  });

  test('an embedding model change re-embeds every chunk', async () => {
    const slug = 'notes/reuse-model';
    await importFromContent(engine, slug, page('Model', ['alpha', 'bravo', 'charlie']));
    embedded = [];
    gateway('openai:text-embedding-3-small');
    await importFromContent(engine, slug, page('Model', ['alpha', 'bravo', 'charlie', 'delta']));
    expect(embedded.length).toBe((await vectors(slug)).size);
  });

  test('a page with protected fences never reuses vectors', async () => {
    const slug = 'notes/reuse-protected';
    const fence = '\n<!--- gbrain:takes:begin -->\nPRIVATE_CANARY\n<!--- gbrain:takes:end -->\n';
    await importFromContent(engine, slug, page('Protected', ['alpha', 'bravo', 'charlie'], fence));
    embedded = [];
    await importFromContent(engine, slug, page('Protected', ['alpha', 'bravo', 'delta'], fence));
    const count = (await vectors(slug)).size;
    expect(embedded.length).toBe(count);
  });

  test('--force-rechunk re-embeds every chunk', async () => {
    const slug = 'notes/reuse-force';
    await importFromContent(engine, slug, page('Force', ['alpha', 'bravo', 'charlie']));
    embedded = [];
    await importFromContent(engine, slug, page('Force', ['alpha', 'bravo', 'delta']), { forceRechunk: true });
    expect(embedded.length).toBe((await vectors(slug)).size);
  });
});
