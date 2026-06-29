import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

describe('importFromContent slug canonicalization', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('explicit mixed-case slug is canonicalized before chunk upsert', async () => {
    const mixed = 'inbox/Explicit-Fix-20260629T003419Z';
    const canonical = 'inbox/explicit-fix-20260629t003419z';
    const md = `# Explicit slug proof\n\nThis page proves mixed-case explicit slugs chunk under the canonical slug.`;

    const result = await importFromContent(engine, mixed, md, { noEmbed: true });

    expect(result.slug).toBe(canonical);
    expect(result.status).toBe('imported');

    const page = await engine.getPage(canonical);
    expect(page?.slug).toBe(canonical);

    const chunks = await engine.getChunks(canonical);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.chunk_text).toContain('mixed-case explicit slugs');
  });
});
