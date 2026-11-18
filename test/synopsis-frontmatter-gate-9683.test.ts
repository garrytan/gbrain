import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readSynopsisTierConfig } from '../src/core/synopsis-sweep.ts';

describe('#9683 synopsis gate honors page frontmatter', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ embedding_dimensions: 1536 } as never);
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a default-source page tagged per_chunk_synopsis makes the tier configured', async () => {
    expect((await readSynopsisTierConfig(engine)).configured).toBe(false);
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter)
       VALUES ('notes/tagged', 'default', 'note', 'Tagged', 'body', '{"contextual_retrieval":"per_chunk_synopsis"}'::jsonb)`);
    expect((await readSynopsisTierConfig(engine)).configured).toBe(true);
  });
});
