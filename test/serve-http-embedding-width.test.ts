/**
 * #1196 — serve --http startup embedding-width guard.
 *
 * A stateless host (container without config.json) resolves the compiled-in
 * default embedding width; against an existing brain with a different
 * vector(N) column, every write fails. runServeHttp now runs doctor's
 * embedding_width_consistency check at startup and prints a loud stderr
 * banner. This pins the helper: mismatch → banner with the recipe;
 * match → null (no banner noise on healthy brains).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { embeddingWidthStartupWarning } from '../src/commands/serve-http.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  // Rule: files that configureGateway must resetGateway in afterAll.
  // The legacy-embedding preload's beforeEach re-applies defaults for
  // subsequent files in the same shard.
  resetGateway();
  await engine.disconnect();
});

async function schemaDims(): Promise<number> {
  const rows = await engine.executeRaw<{ format_type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS format_type
       FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass
        AND attname = 'embedding'
        AND NOT attisdropped`,
  );
  const m = rows[0].format_type.match(/vector\((\d+)\)/i);
  return parseInt(m![1], 10);
}

describe('embeddingWidthStartupWarning (#1196)', () => {
  test('resolved width matches the schema: no banner', async () => {
    const dims = await schemaDims();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: dims,
      env: { ...process.env },
    });
    expect(await embeddingWidthStartupWarning(engine)).toBeNull();
  });

  test('resolved width diverges from the schema: loud banner with recipe', async () => {
    // Simulate the stateless-container fallthrough: gateway resolves a
    // width different from the brain's actual vector(N) column.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 768,
      env: { ...process.env },
    });
    const warn = await embeddingWidthStartupWarning(engine);
    expect(warn).not.toBeNull();
    expect(warn!).toContain('[serve-http] WARNING');
    expect(warn!).toContain('mismatch');
    expect(warn!).toContain('GBRAIN_EMBEDDING_DIMENSIONS');
  });
});
