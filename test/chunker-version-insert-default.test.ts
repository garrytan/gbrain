/** Chunk safety versions are minted by full imports, never body-only writes. */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { ChunkInput } from '../src/core/types.ts';

const protectedBody = 'Public version fixture.\n<!--- gbrain:takes:begin -->\nPRIVATE_VERSION_CANARY\n<!--- gbrain:takes:end -->';

describe('verified chunk safety versions', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    // Pin the embedding shape this file hard-codes (1536-d vectors below) instead
    // of inheriting whatever a previous file in the shard left on the gateway —
    // initSchema sizes the vector columns from the gateway, and a leaked 1280-d
    // config turned every upsert here into "expected 1280 dimensions, not 1536".
    resetGateway();
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); resetGateway(); }, 30_000);

  async function version(slug: string): Promise<number> {
    const rows = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages WHERE slug = $1', [slug]);
    return Number(rows[0].chunker_version);
  }
  async function imported(slug: string, body = protectedBody) {
    await importFromContent(engine, slug, `---\ntype: note\ntitle: Version fixture\n---\n${body}`, { noEmbed: true, forceRechunk: true });
    expect(await version(slug)).toBe(MARKDOWN_CHUNKER_VERSION);
    return (await engine.getPage(slug, { sourceId: 'default' }))!;
  }

  test('body-only insert is unsealed, and explicit current versions cannot certify chunks', async () => {
    for (const supplied of [undefined, MARKDOWN_CHUNKER_VERSION, 2]) {
      const slug = `notes/unsealed-${supplied ?? 'unset'}`;
      await engine.putPage(slug, { type: 'note', title: 'Version fixture', compiled_truth: protectedBody, chunker_version: supplied });
      expect(await version(slug)).toBeLessThan(MARKDOWN_CHUNKER_VERSION);
      if (supplied === 2) expect(await version(slug)).toBe(2);
    }
  });

  test('metadata-only put preserves a seal, body changes invalidate it even after marker removal', async () => {
    const slug = 'notes/body-write-version';
    const page = await imported(slug);
    await engine.putPage(slug, { ...page, title: 'Changed public title' });
    expect(await version(slug)).toBe(MARKDOWN_CHUNKER_VERSION);
    await engine.putPage(slug, { ...page, compiled_truth: 'All markers removed.', chunker_version: MARKDOWN_CHUNKER_VERSION });
    expect(await version(slug)).toBeLessThan(0);
    expect(await engine.getChunks(slug, { requireSafeChunks: true })).toEqual([]);
    expect((await engine.getChunks(slug)).length).toBeGreaterThan(0);
  });

  test('embedding-only refresh preserves a seal; text, metadata, and chunk-set changes invalidate', async () => {
    const slug = 'notes/chunk-write-version';
    await imported(slug);
    let chunks = await engine.getChunks(slug);
    const vector = new Float32Array(1536); vector[0] = 1;
    await engine.upsertChunks(slug, chunks.map(chunk => ({ ...chunk, embedding: vector })) as ChunkInput[]);
    expect(await version(slug)).toBe(MARKDOWN_CHUNKER_VERSION);
    expect((await engine.getChunks(slug, { requireSafeChunks: true }))[0].embedding_is_null).toBe(false);
    for (const mutation of ['text', 'metadata', 'addition', 'removal']) {
      await imported(slug);
      chunks = await engine.getChunks(slug);
      const next = chunks.map(chunk => ({ ...chunk })) as ChunkInput[];
      if (mutation === 'text') next[0].chunk_text = 'PRIVATE_REPLACEMENT_CANARY';
      if (mutation === 'metadata') next[0].doc_comment = 'PRIVATE_METADATA_CANARY';
      if (mutation === 'addition') next.push({ chunk_index: next.length, chunk_source: 'compiled_truth', chunk_text: 'PRIVATE_ADDED_CANARY' });
      if (mutation === 'removal') next.length = 0;
      await engine.upsertChunks(slug, next);
      expect(await version(slug), mutation).toBeLessThan(0);
      expect(await engine.getChunks(slug, { requireSafeChunks: true })).toEqual([]);
    }
  });

  test('refresh and version revert invalidate existing chunks before exposing a changed body', async () => {
    const slug = 'notes/refresh-version';
    await imported(slug);
    await engine.createVersion(slug, { sourceId: 'default' });
    const [snapshot] = await engine.getVersions(slug, { sourceId: 'default' });
    await engine.refreshPageBody(slug, 'default', 'Public replacement body.', '', 'changed');
    expect(await version(slug)).toBeLessThan(0);
    await imported(slug, 'Public replacement body.');
    await engine.revertToVersion(slug, snapshot.id, { sourceId: 'default' });
    expect(await version(slug)).toBeLessThan(0);
    expect(await engine.getChunks(slug, { requireSafeChunks: true })).toEqual([]);
  });
});
