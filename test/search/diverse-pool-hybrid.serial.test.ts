/**
 * `search.diverse_pool_depth` through bare hybridSearch on PGLite (GBRA-60 S1):
 * with the knob set, the deduped pool holds one row per session, the reranker
 * reads at least N rows and every arm fetches at least N candidates; with it
 * off (every bundle) the pipeline is unchanged. Serial: it isolates
 * GBRAIN_HOME and stubs the process-wide gateway, as
 * hybrid-reranker-integration.serial.test.ts does.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { resolveHybridRequest } from '../../src/core/search/hybrid/request.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';
import type { SearchOpts } from '../../src/core/types.ts';

const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));
const SESSION = 'media/chat/2026-05-20-standup';
let engine: PGLiteEngine;
let prevGbrainHome: string | undefined;
let isolatedHome: string;

function rerankOpts(topNIn: number, seen: { docs: number }): SearchOpts {
  return {
    limit: 10,
    reranker: {
      enabled: true, topNIn, topNOut: null,
      rerankerFn: async (input: RerankInput): Promise<RerankResult[]> => {
        seen.docs = input.documents.length;
        return input.documents.map((_, i) => ({ index: i, relevanceScore: 1 - i * 0.01 }));
      },
    },
  };
}

beforeAll(async () => {
  prevGbrainHome = process.env.GBRAIN_HOME;
  isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-diverse-pool-home-'));
  process.env.GBRAIN_HOME = isolatedHome;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const pages: Array<[string, string[]]> = [
    [`${SESSION}/part-1`, ['zephyr budget review opening remarks', 'zephyr budget review travel line items', 'zephyr budget review hiring plan numbers']],
    [`${SESSION}/part-2`, ['zephyr budget review closing decisions and owners']],
    ['notes/zephyr-gold', ['zephyr budget review final approved figure']],
    ['notes/zephyr-other', ['zephyr budget review vendor shortlist']],
  ];
  for (const [slug, chunks] of pages) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: chunks.join('\n\n') });
    await installFixtureChunks(engine, slug, chunks.map((chunk_text, chunk_index) => ({ chunk_index, chunk_text, chunk_source: 'compiled_truth' as const })));
  }
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests(async (args: any) => ({ embeddings: args.values.map(() => FAKE_EMB) }) as any);
});

afterEach(async () => {
  await engine.setConfig('search.diverse_pool_depth', '0');
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (prevGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevGbrainHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

describe('search.diverse_pool_depth off (every bundle)', () => {
  test('a session keeps several rows and the reranker reads top_n_in rows', async () => {
    const seen = { docs: 0 };
    const out = await hybridSearch(engine, 'zephyr budget review', rerankOpts(2, seen));
    expect(seen.docs).toBe(2);
    expect(out.filter(r => r.slug.startsWith(`${SESSION}/`)).length).toBeGreaterThan(1);
    const req = await resolveHybridRequest(engine, 'zephyr budget review', { limit: 10 });
    expect(req.searchOpts.limit).toBe(50);
  });
});

describe('search.diverse_pool_depth on', () => {
  test('one row per session reaches the reranker, which reads at least N rows', async () => {
    await engine.setConfig('search.diverse_pool_depth', '10');
    const seen = { docs: 0 };
    const out = await hybridSearch(engine, 'zephyr budget review', rerankOpts(2, seen));
    expect(out.filter(r => r.slug.startsWith(`${SESSION}/`))).toHaveLength(1);
    expect(out.filter(r => !r.slug.startsWith(`${SESSION}/`)).map(r => r.slug).sort()).toEqual(['notes/zephyr-gold', 'notes/zephyr-other']);
    expect(seen.docs).toBe(3);
  });

  test('every arm fetches at least N candidates, still capped at MAX_SEARCH_LIMIT', async () => {
    await engine.setConfig('search.diverse_pool_depth', '80');
    expect((await resolveHybridRequest(engine, 'zephyr budget review', { limit: 10 })).searchOpts.limit).toBe(80);
    await engine.setConfig('search.diverse_pool_depth', '100');
    expect((await resolveHybridRequest(engine, 'zephyr budget review', { limit: 60 })).searchOpts.limit).toBe(100);
  });
});
