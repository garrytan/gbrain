/**
 * The cross-modal image arm on a text-only brain: a question that mentions
 * photos infers image modality, but a brain with no `embedding_image` rows
 * has nothing for that arm to search. It is skipped, so no multimodal embed
 * is attempted and no failed vector arm is reported while the text arm
 * answers. A brain that holds image vectors runs the arm when a configured
 * model can embed images, and stays a text query when none can.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';
import { brainHasImageVectors, forgetImageVectorPresence } from '../src/core/search/image-vector-presence.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

let engine: PGLiteEngine;
let sourceId: string;
const Q = 'show me the photos from the beach trip';
const embed = (text: string) => { const v = new Float32Array(1024); for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 1024]! += 1; return v; };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  await putPage(engine, sourceId, 'notes/beach-trip', page('note', 'Beach trip', 'We took photos at the beach trip in June and shared them with the family.'));
  await putPage(engine, sourceId, 'media/beach-photo', page('note', 'Beach photo', 'A beach photo.'));
}, 120_000);

afterAll(async () => { await engine?.disconnect(); }, 60_000);

const origFetch = globalThis.fetch;
let fetchUrlsSeen: string[] = [];
afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

/** Voyage models with a stubbed endpoint; `multimodal` adds the image-capable model. */
function configureVoyage(multimodal: boolean) {
  configureGateway({
    embedding_model: 'voyage:voyage-4',
    embedding_dimensions: 1024,
    ...(multimodal ? { embedding_multimodal_model: 'voyage:voyage-multimodal-3' } : {}),
    env: { VOYAGE_API_KEY: 'voyage-test-key' },
  });
  fetchUrlsSeen = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchUrlsSeen.push(typeof url === 'string' ? url : url.toString());
    return new Response(JSON.stringify({ data: [{ embedding: Array.from(embed('beach'), x => x || 0), index: 0 }], model: 'voyage-multimodal-3' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

/** Gives media/beach-photo an image chunk for the duration of `run`. */
async function withImageVector(run: () => Promise<void>) {
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', ['media/beach-photo', sourceId]);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality, embedding_image)
    VALUES ($1, 1000, 'beach photo', 'image_asset', 'image', $2::vector)`, [row!.id, `[${Array.from(embed('beach'), x => x || 0).join(',')}]`]);
  forgetImageVectorPresence(engine);
  try {
    expect(await brainHasImageVectors(engine)).toBe(true);
    await run();
  } finally {
    await engine.executeRaw("DELETE FROM content_chunks WHERE page_id = $1 AND modality = 'image'", [row!.id]);
    forgetImageVectorPresence(engine);
  }
}

async function search(): Promise<{ slugs: string[]; imageHits: string[]; meta: HybridSearchMeta | null }> {
  let meta: HybridSearchMeta | null = null;
  const rows = await hybridSearch(engine, Q, { sourceId, limit: 5, queryEmbedFn: embed, onMeta: m => { meta = m; } });
  return { slugs: rows.map(r => r.slug), imageHits: rows.filter(r => (r.chunk_source as string) === 'image_asset').map(r => r.slug), meta };
}
const stages = (meta: HybridSearchMeta | null) => ((meta as { degraded?: Array<{ stage?: string } | string> } | null)?.degraded ?? []).map(d => typeof d === 'string' ? d : d.stage);

describe('cross-modal image arm', () => {
  test('a text-only brain skips it: the text arm answers and no vector arm is reported failed', async () => {
    forgetImageVectorPresence(engine);
    expect(await brainHasImageVectors(engine)).toBe(false);
    const { slugs, meta } = await search();
    expect(slugs).toContain('notes/beach-trip');
    expect(stages(meta)).not.toContain('vector_arm_failed');
  });

  test('a brain with image vectors and a model that can embed images runs the image arm', async () => {
    configureVoyage(true);
    await withImageVector(async () => {
      const { imageHits, meta } = await search();
      expect(fetchUrlsSeen.some(u => u.includes('multimodalembeddings'))).toBe(true);
      expect(imageHits).toEqual(['media/beach-photo']);
      expect(stages(meta)).not.toContain('vector_arm_failed');
    });
  });

  test('a brain with image vectors but no model that can embed images stays a text query', async () => {
    configureVoyage(false);
    await withImageVector(async () => {
      const { slugs, imageHits, meta } = await search();
      expect(fetchUrlsSeen.some(u => u.includes('multimodalembeddings'))).toBe(false);
      expect(slugs).toContain('notes/beach-trip');
      expect(imageHits).toEqual([]);
      expect(stages(meta)).not.toContain('vector_arm_failed');
    });
  });
});
