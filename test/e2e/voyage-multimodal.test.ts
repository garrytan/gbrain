// Phase 10 E2E (gated VOYAGE_API_KEY): real-API smoke for embedMultimodal.
// Skips silently when VOYAGE_API_KEY is not set so unit-test runs without
// the key still pass.
//
// Pairs with the Phase 1 bun --compile probe (which exercises decode but
// not the network call) — this hits Voyage for real and asserts a
// 1024-dim vector comes back with sane shape.

import { describe, expect, test, beforeAll, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { configureGateway, embedMultimodal, resetGateway } from '../../src/core/ai/gateway.ts';

const HAS_KEY = !!process.env.VOYAGE_API_KEY;

afterEach(() => {
  resetGateway();
});

describe.if(HAS_KEY)('voyage-multimodal-3 (real API, gated VOYAGE_API_KEY)', () => {
  beforeAll(() => {
    configureGateway({
      embedding_model: 'voyage:voyage-multimodal-3',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: process.env.VOYAGE_API_KEY! },
    });
  });

  test('embeds the tiny PNG fixture into a 1024-dim vector', async () => {
    // Reuse the Phase 1 fixture (the AVIF is fine for an embed call; Voyage
    // accepts data URLs of common image types).
    const buf = readFileSync('test/fixtures/images/tiny.avif');
    const data = buf.toString('base64');
    const out = await embedMultimodal([{ kind: 'image_base64', data, mime: 'image/avif' }]);
    expect(out.length).toBe(1);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0].length).toBe(1024);
    // Sanity: at least one nonzero component (a real embedding, not all-zeros).
    const sumAbs = out[0].reduce((a, b) => a + Math.abs(b), 0);
    expect(sumAbs).toBeGreaterThan(0);
  }, 60_000);
});

if (!HAS_KEY) {
  test.skip('voyage-multimodal-3 E2E skipped (VOYAGE_API_KEY unset)', () => {});
}
