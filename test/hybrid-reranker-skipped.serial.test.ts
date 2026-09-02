/**
 * v0.48.2 — end-to-end: a balanced search on a brain WITHOUT the reranker's
 * provider key stamps `{stage: 'reranker_skipped', reason: 'no_key'}` on
 * `HybridSearchMeta.degraded`, keeps RRF order, writes nothing to stderr;
 * with the key present the reranker runs and no skip is stamped.
 *
 * Runs the MAIN hybrid path (embedding stubbed through
 * `__setEmbedTransportForTests`) on a fresh PGLite brain; the reranker HTTP
 * is stubbed through `__setRerankTransportForTests`. Serial: mutates the
 * module-global gateway and the once-per-process no_key memo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HybridSearchMeta, SearchResult } from '../src/core/types.ts';

const { hybridSearch, hybridSearchCached, awaitPendingSearchCacheWrites } = await import('../src/core/search/hybrid.ts');
const {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
  __setRerankTransportForTests,
  _resetSunsetWarningsForTest,
} = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;
const savedAuditDir = process.env.GBRAIN_AUDIT_DIR;
const savedVoyage = process.env.VOYAGE_API_KEY;

function configure(withVoyageKey: boolean): void {
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake', ...(withVoyageKey ? { VOYAGE_API_KEY: 'pa-fake' } : {}) },
  });
  __setEmbedTransportForTests((async (args: any) => ({
    embeddings: Array.from({ length: args.values.length }, () => Array.from({ length: 1536 }, () => 0.1)),
  })) as any);
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-reranker-skipped-'));
  process.env.GBRAIN_HOME = tmpHome;
  process.env.GBRAIN_AUDIT_DIR = join(tmpHome, 'audit');
  delete process.env.VOYAGE_API_KEY;

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const fixtures: Array<[string, string, string]> = [
    ['alice-foo', 'Alice Foo', 'person'],
    ['bob-bar', 'Bob Bar', 'company'],
    ['carol-baz', 'Carol Baz', 'note'],
  ];
  for (const [slug, title, type] of fixtures) {
    const truth = `${title} is a builder shipping reranker plumbing.`;
    await engine.putPage(slug, { type, title, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterEach(() => {
  __setRerankTransportForTests(null);
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  __setRerankTransportForTests(null);
  _resetSunsetWarningsForTest();
  resetGateway();
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  if (savedAuditDir === undefined) delete process.env.GBRAIN_AUDIT_DIR;
  else process.env.GBRAIN_AUDIT_DIR = savedAuditDir;
  if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
  try { await engine.disconnect(); } catch { /* ignore */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function run(query: string): Promise<{ results: SearchResult[]; meta: HybridSearchMeta; stderr: string }> {
  let meta: HybridSearchMeta | undefined;
  const orig = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return orig(chunk, ...rest);
  };
  let results: SearchResult[];
  try {
    results = await hybridSearch(engine, query, { limit: 5, onMeta: (m) => { meta = m; } });
  } finally {
    (process.stderr as any).write = orig;
  }
  if (!meta) throw new Error('onMeta never fired');
  return { results, meta, stderr: captured };
}

describe('balanced search without VOYAGE_API_KEY (v0.48.2)', () => {
  test('stamps reranker_skipped (no_key) on meta, keeps results, prints nothing', async () => {
    configure(false);
    _resetSunsetWarningsForTest();
    let rerankCalls = 0;
    __setRerankTransportForTests(async () => {
      rerankCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    const { results, meta, stderr } = await run('builder');
    expect(results.length).toBeGreaterThan(0);
    expect(meta.degraded ?? []).toContainEqual({ stage: 'reranker_skipped', reason: 'no_key' });
    expect(results.every((r) => r.rerank_score === undefined)).toBe(true);
    expect(rerankCalls).toBe(0);
    expect(stderr).not.toContain('VOYAGE_API_KEY');

    // Second search in the same process: still stamped (the stamp is per
    // search; only the audit row is once-per-process).
    const second = await run('builder shipping');
    expect(second.meta.degraded ?? []).toContainEqual({ stage: 'reranker_skipped', reason: 'no_key' });
  });

  test('a reranker_skipped stamp keeps the FULL cache TTL (config state, not a transient limp)', async () => {
    configure(false);
    _resetSunsetWarningsForTest();
    __setRerankTransportForTests(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    await engine.executeRaw('DELETE FROM query_cache');
    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearchCached(engine, 'builder plumbing', { limit: 5, onMeta: (m) => { meta = m; } });
    expect(results.length).toBeGreaterThan(0);
    expect(meta?.degraded ?? []).toContainEqual({ stage: 'reranker_skipped', reason: 'no_key' });
    await awaitPendingSearchCacheWrites();
    const rows = await engine.executeRaw<{ ttl_seconds: number }>('SELECT ttl_seconds FROM query_cache');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ttl_seconds).toBe(3600);
  });

  test('with the key present the reranker runs: rerank_score stamped, no skip entry', async () => {
    configure(true);
    __setRerankTransportForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const n = Array.isArray(body.documents) ? body.documents.length : 0;
      return new Response(
        JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ index: i, relevance_score: 0.9 - i * 0.1 })) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const { results, meta } = await run('builder');
    expect(results.length).toBeGreaterThan(0);
    expect((meta.degraded ?? []).some((d) => d.stage === 'reranker_skipped')).toBe(false);
    expect(results[0]!.rerank_score).toBe(0.9);
  });
});
