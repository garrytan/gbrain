/**
 * Structural pins for Upstage's Solar embedding compatibility shim.
 *
 * Upstage uses two model IDs in one embedding space: passage for ingest and
 * query for search. The gateway carries the side as providerOptions
 * `input_type`; upstageCompatFetch translates that into the correct model ID
 * before the OpenAI-compatible request goes out.
 */

import { describe, expect, test } from 'bun:test';

const GATEWAY_PATH = new URL('../../src/core/ai/gateway.ts', import.meta.url);

describe('upstageCompatFetch — shim structural shape', () => {
  test('declared at module scope alongside provider compatibility shims', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    expect(src).toMatch(/const upstageCompatFetch\s*=\s*\(async \(input: RequestInfo \| URL/);
  });

  test('body rewrite maps input_type query/document to Solar model pair', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    const start = src.indexOf('const upstageCompatFetch');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, start + 5000);
    expect(block).toContain('solar-embedding-1-large-query');
    expect(block).toContain('solar-embedding-1-large-passage');
    expect(block).toMatch(/parsed\.input_type\s*===\s*['"]query['"]/);
    expect(block).toMatch(/delete\s+parsed\.input_type/);
  });

  test('instantiateEmbedding branch installs upstageCompatFetch for upstage recipe', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    const fnIdx = src.indexOf('function instantiateEmbedding(');
    const ocIdx = src.indexOf("case 'openai-compatible':", fnIdx);
    const branchIdx = src.indexOf("recipe.id === 'upstage'", ocIdx);
    const wrapperIdx = src.indexOf('upstageCompatFetch', branchIdx);
    expect(fnIdx).toBeGreaterThan(0);
    expect(ocIdx).toBeGreaterThan(0);
    expect(branchIdx).toBeGreaterThan(ocIdx);
    expect(wrapperIdx).toBeGreaterThan(branchIdx);
  });
});
