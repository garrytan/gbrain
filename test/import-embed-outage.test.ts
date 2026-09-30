/**
 * An embedding outage must not block the text write.
 *
 * importFromContent embeds inline before its canonical transaction. A provider
 * failure (outage, rate limit, missing key) used to throw before the page was
 * stored. Now the page text and chunks commit with NULL vectors, no embedding
 * signature is stamped, the result reports `embedding_deferred`, and the stale
 * sweep embeds the chunks once the provider recovers.
 *
 * PGLite in-memory; the "provider" is a gateway stub that throws ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, importCodeFile } from '../src/core/import-file.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  resetGateway();
  if (engine) await engine.disconnect();
}, 60_000);

describe('embedding outage', () => {
  test('text and chunks persist with NULL vectors and the result says the embedding is deferred', async () => {
    const r = await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      resetGateway();
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      return importFromContent(engine, 'notes/decision', `---\ntitle: Decision\n---\n\nWe chose vendor B for the widget.\n`, {});
    });
    expect(r.status).toBe('imported');
    expect(r.embedding_deferred).toBe(true);
    const pages = await engine.executeRaw<{ compiled_truth: string; embedding_signature: string | null }>(
      `SELECT compiled_truth, embedding_signature FROM pages WHERE slug = 'notes/decision'`);
    expect(pages).toHaveLength(1);
    expect(pages[0].compiled_truth).toContain('vendor B');
    expect(pages[0].embedding_signature).toBeNull();
    const chunks = await engine.executeRaw<{ n: number; embedded: number }>(
      `SELECT count(*)::int AS n, count(c.embedding)::int AS embedded
         FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'notes/decision'`);
    expect(chunks[0].n).toBeGreaterThan(0);
    expect(chunks[0].embedded).toBe(0);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBeGreaterThan(0);
  });

  test('a code file whose embedding failed is not stamped as embedded with the current model', async () => {
    const r = await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      resetGateway();
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      return importCodeFile(engine, 'src/widget.ts', 'export function widget(): number {\n  return 42;\n}\n', {});
    });
    expect(r.status).toBe('imported');
    const [page] = await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE source_path = 'src/widget.ts'`);
    expect(page.embedding_signature).toBeNull();
  });
});
