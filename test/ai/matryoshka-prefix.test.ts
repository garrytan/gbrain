/**
 * PR #5921 (@abudhi19), wave 14 P3.18: a Matryoshka model whose endpoint returns its native width whatever
 * `dimensions` asked is fitted to the brain's width by the card-documented rule (slice from the start, L2
 * re-normalize), declared on the recipe's embedding touchpoint (`matryoshka`), never by a model id in the gateway.
 *
 * Protects: a 4096-wide Nemotron-3-Embed-8B response lands in a 1024/2048 brain as a unit-length prefix; a
 * response of any other width, a target width the card does not list, a model with no declaration, and a vector
 * already at the expected width all keep today's behavior (mismatch error or bytes unchanged); a prefix with a
 * non-finite coordinate or a zero or overflowing norm is refused, never indexed.
 * Seams: `__setEmbedTransportForTests`, `__setTestRecipesForTests`, `fitMatryoshkaPrefix`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __setEmbedTransportForTests, configureGateway, embed, resetGateway } from '../../src/core/ai/gateway.ts';
import { fitMatryoshkaPrefix } from '../../src/core/ai/embedding-guard.ts';
import { nvidia } from '../../src/core/ai/recipes/nvidia.ts';
import { __setTestRecipesForTests } from '../../src/core/ai/recipes/index.ts';
import type { Recipe } from '../../src/core/ai/types.ts';

const MODEL = 'nvidia/nemotron-3-embed-8b';

function configureNemotron(dimensions: number, model = MODEL): void {
  configureGateway({ embedding_model: `nvidia:${model}`, embedding_dimensions: dimensions, env: { NVIDIA_API_KEY: 'test-only' } });
}
function respond(vectors: number[][]): void {
  __setEmbedTransportForTests(async (args: any) => ({ embeddings: vectors, usage: { tokens: args.values.length } }) as any);
}
/** 4096 wide; the coordinate just past the prefix is large, so normalizing the whole vector would change the result. */
function native(prefixWidth: number, first: number, second: number): number[] {
  const v = new Array(4096).fill(0);
  v[0] = first; v[1] = second; v[prefixWidth] = 12;
  return v;
}

beforeEach(() => { resetGateway(); __setEmbedTransportForTests(null); });
afterEach(() => { __setEmbedTransportForTests(null); __setTestRecipesForTests([]); });
afterAll(() => resetGateway());

describe('fitMatryoshkaPrefix (pure)', () => {
  test('the declared model at its native width is sliced to a listed prefix and re-normalized', () => {
    expect(nvidia.touchpoints.embedding?.matryoshka?.[MODEL]).toEqual({ native: 4096, prefixes: [1024, 2048] });
    const out = fitMatryoshkaPrefix(nvidia, 'nvidia/Nemotron-3-Embed-8B', native(1024, 3, 4), 1024);
    expect(out).toHaveLength(1024);
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
    expect(out[2]).toBe(0);
  });

  test('anything else passes through untouched', () => {
    const v = native(1024, 3, 4);
    expect(fitMatryoshkaPrefix(nvidia, MODEL, v, 1536)).toBe(v);
    expect(fitMatryoshkaPrefix(nvidia, 'nvidia/nv-embed-v1', v, 1024)).toBe(v);
    const narrow = new Array(1024).fill(0.5);
    expect(fitMatryoshkaPrefix(nvidia, MODEL, narrow, 1024)).toBe(narrow);
    const odd = new Array(3072).fill(1);
    expect(fitMatryoshkaPrefix(nvidia, MODEL, odd, 1024)).toBe(odd);
  });
});

describe('embed() through the nvidia recipe', () => {
  test('a 4096-wide response fits a 1024 and a 2048 brain, in batch order', async () => {
    configureNemotron(1024);
    respond([native(1024, 3, 4), native(1024, 4, 3)]);
    const vectors = await embed(['first passage', 'second passage']);
    expect(vectors.map((v) => v.length)).toEqual([1024, 1024]);
    expect(vectors[0]![0]).toBeCloseTo(0.6, 6);
    expect(vectors[0]![1]).toBeCloseTo(0.8, 6);
    expect(vectors[1]![0]).toBeCloseTo(0.8, 6);
    expect(vectors[1]![1]).toBeCloseTo(0.6, 6);

    configureNemotron(2048);
    respond([native(2048, 3, 4)]);
    const [wide] = await embed(['one passage']);
    expect(wide).toHaveLength(2048);
    expect(wide![0]).toBeCloseTo(0.6, 6);
  });

  test('an already expected-width vector is unchanged', async () => {
    configureNemotron(1024);
    const v = new Array(1024).fill(0); v[0] = 3; v[1] = 4;
    respond([v]);
    const [out] = await embed(['already narrow']);
    expect(out![0]).toBe(3);
    expect(out![1]).toBe(4);
  });

  test('a non-finite coordinate, a zero norm and an overflowing norm are refused', async () => {
    configureNemotron(1024);
    for (const [label, a, b] of [['nan', Number.NaN, 1], ['inf', Number.POSITIVE_INFINITY, 1], ['overflow', Number.MAX_VALUE, Number.MAX_VALUE], ['zero', 0, 0]] as const) {
      const v = new Array(4096).fill(0); v[0] = a; v[1] = b;
      respond([v]);
      await expect(embed([label])).rejects.toThrow(/finite|norm|zero/i);
    }
  });

  test('a wrong raw width, an unlisted target width and an undeclared model keep the mismatch error', async () => {
    configureNemotron(1024);
    respond([new Array(3072).fill(1)]);
    await expect(embed(['wrong raw width'])).rejects.toThrow(/3072/);
    configureNemotron(1536);
    respond([new Array(4096).fill(1)]);
    await expect(embed(['unlisted target'])).rejects.toThrow(/4096/);
    configureNemotron(1024, 'nvidia/nv-embed-v1');
    respond([new Array(4096).fill(1)]);
    await expect(embed(['undeclared model'])).rejects.toThrow(/4096/);
  });

  test('a recipe with no declaration is byte-for-byte unchanged', async () => {
    const plain: Recipe = { id: 'synthetic-plain', name: 'plain', tier: 'openai-compat', implementation: 'openai-compatible', base_url_default: 'http://127.0.0.1:9/v1',
      touchpoints: { embedding: { models: ['plain-embed'], default_dims: 1024, max_batch_tokens: 8192 } } };
    __setTestRecipesForTests([plain]);
    configureGateway({ embedding_model: 'synthetic-plain:plain-embed', embedding_dimensions: 1024, env: {} });
    const v = new Array(1024).fill(0); v[0] = 3; v[1] = 4;
    respond([v]);
    const [out] = await embed(['plain']);
    expect(Array.from(out!.slice(0, 3))).toEqual([3, 4, 0]);
    respond([new Array(4096).fill(1)]);
    await expect(embed(['plain wide'])).rejects.toThrow(/4096/);
  });
});
