// v0.27.1 follow-up: searchVector column routing — `embedding_image`
// path returns image rows only, default `embedding` path returns text/code
// rows only. Verifies the modality-filter contract that backs the
// `gbrain query --image <path>` flag.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function fakeText1536(seed: number): Float32Array {
  const out = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) out[i] = (i + seed) / 1536;
  return out;
}

function fakeImage1024(seed: number): Float32Array {
  const out = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) out[i] = (i + seed) / 1024;
  return out;
}

async function seedTextPage(slug: string, vec: Float32Array) {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: `body for ${slug}`,
    timeline: '',
  });
  await engine.upsertChunks(slug, [
    {
      chunk_index: 0,
      chunk_text: `body for ${slug}`,
      chunk_source: 'compiled_truth',
      embedding: vec,
      modality: 'text',
    },
  ]);
}

async function seedImagePage(slug: string, vec: Float32Array) {
  await engine.putPage(slug, {
    type: 'image',
    page_kind: 'image',
    title: slug,
    compiled_truth: '',
    timeline: '',
  });
  await engine.upsertChunks(slug, [
    {
      chunk_index: 0,
      chunk_text: slug,
      chunk_source: 'image_asset',
      embedding_image: vec,
      modality: 'image',
    },
  ]);
}

describe('searchVector column routing (v0.27.1)', () => {
  test('default path searches embedding column and returns text rows only', async () => {
    await seedTextPage('notes/text-only', fakeText1536(1));
    await seedImagePage('photos/img-only', fakeImage1024(1));

    const out = await engine.searchVector(fakeText1536(1), { limit: 10 });
    const slugs = out.map(r => r.slug);
    expect(slugs).toContain('notes/text-only');
    expect(slugs).not.toContain('photos/img-only');
  });

  test('embeddingColumn=embedding_image searches image column and returns image rows only', async () => {
    await seedTextPage('notes/text-only', fakeText1536(2));
    await seedImagePage('photos/img-only', fakeImage1024(2));

    const out = await engine.searchVector(fakeImage1024(2), {
      limit: 10,
      embeddingColumn: 'embedding_image',
    });
    const slugs = out.map(r => r.slug);
    expect(slugs).toContain('photos/img-only');
    expect(slugs).not.toContain('notes/text-only');
  });

  test('image-column path scores by cosine and orders nearest first', async () => {
    // Two image pages with different vectors; query nearest the second.
    const vecA = fakeImage1024(0);
    const vecB = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) vecB[i] = (i + 100) / 1024;

    await seedImagePage('photos/a', vecA);
    await seedImagePage('photos/b', vecB);

    const hits = await engine.searchVector(vecB, {
      limit: 5,
      embeddingColumn: 'embedding_image',
    });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].slug).toBe('photos/b');
  });

  test('searchKeyword hides image rows by default (modality filter)', async () => {
    await seedTextPage('notes/keyword', fakeText1536(3));
    await seedImagePage('photos/keyword', fakeImage1024(3));
    // Force image chunk_text to overlap with the text chunk's words so the
    // FTS would otherwise match both rows.
    await engine.upsertChunks('photos/keyword', [
      {
        chunk_index: 0,
        chunk_text: 'body for notes/keyword',
        chunk_source: 'image_asset',
        embedding_image: fakeImage1024(3),
        modality: 'image',
      },
    ]);

    const out = await engine.searchKeyword('body', { limit: 10 });
    const slugs = out.map(r => r.slug);
    expect(slugs).toContain('notes/keyword');
    expect(slugs).not.toContain('photos/keyword');
  });
});
