/**
 * Cat 40 Hard R0: a hard reranker failure carries the reason the gateway can
 * actually tell apart, through the REAL wire path (gateway.rerank over fetch
 * to local servers, no transport seam).
 *
 * The held-out run's slots pointed `provider_base_urls.voyage` at a metering
 * proxy port from an earlier process, so every rerank call got "connection
 * refused" and the wire said only `provider_error`. A timeout said the same:
 * the abort timer's Error reached the catch as a plain Error, not an
 * AbortError, and was filed as a network failure.
 *
 * Serial: configureGateway changes the process-wide AI gateway and the audit
 * dir is set through process.env; binds local ports.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { applyReranker, type RerankFailedReason } from '../src/core/search/rerank.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
import { readRecentRerankFailures } from '../src/core/rerank-audit.ts';
import type { SearchResult } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

const rows = (): SearchResult[] => ['a', 'b', 'c'].map((s, i) => ({
  slug: `notes/${s}`, page_id: i + 1, title: s, type: 'note', chunk_text: `${s} text`, chunk_source: 'compiled_truth',
  chunk_id: i + 1, chunk_index: 0, score: 1 - i / 10, stale: false,
} as SearchResult));

let server: ReturnType<typeof Bun.serve>;
let deadPort: number;
let auditDir: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: async (req) => {
      const status = Number(new URL(req.url).pathname.split('/')[1]);
      if (status === 0) { await Bun.sleep(2_000); return Response.json({ data: [] }); }
      if (status === 200) return Response.json({ data: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 }] });
      return new Response('{"detail":"no"}', { status });
    },
  });
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  deadPort = probe.port!;
  probe.stop(true);
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-reason-'));
});

afterAll(() => {
  server.stop(true);
  __setEmbedTransportForTests(null);
  resetGateway();
  rmSync(auditDir, { recursive: true, force: true });
});

/** Rerank against `baseUrl` with the real gateway and fetch; returns the reported failure reason (undefined on success). */
async function rerankVia(baseUrl: string, timeoutMs = 2_000): Promise<{ reason?: RerankFailedReason; out: SearchResult[] }> {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'vk-test' },
    base_urls: { voyage: baseUrl },
  } as any);
  let reason: RerankFailedReason | undefined;
  const out = await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => applyReranker('which note', rows(), {
    enabled: true, topNIn: 30, topNOut: null, model: 'voyage:rerank-2.5', timeoutMs,
    onFailure: (r) => { reason = r; },
  }));
  return { reason, out };
}

describe('rerank failure reasons on the real wire path', () => {
  test('an unreachable endpoint (connection refused) reports unreachable, not provider_error', async () => {
    const { reason, out } = await rerankVia(`http://127.0.0.1:${deadPort}/v1`);
    expect(reason).toBe('unreachable');
    expect(out.map(r => r.slug)).toEqual(['notes/a', 'notes/b', 'notes/c']);
  });

  test('a call past its timeout reports timeout', async () => {
    const t0 = performance.now();
    const { reason } = await rerankVia(`http://127.0.0.1:${server.port}/0`, 150);
    expect(reason).toBe('timeout');
    expect(performance.now() - t0).toBeLessThan(1_500);
    const row = await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => readRecentRerankFailures(1).at(-1));
    expect(row?.reason).toBe('timeout');
  });

  test('HTTP 429 reports rate_limited', async () => {
    expect((await rerankVia(`http://127.0.0.1:${server.port}/429`)).reason).toBe('rate_limited');
  });

  test('HTTP 401 reports auth', async () => {
    expect((await rerankVia(`http://127.0.0.1:${server.port}/401`)).reason).toBe('auth');
  });

  test('HTTP 503 and 400 report provider_error', async () => {
    expect((await rerankVia(`http://127.0.0.1:${server.port}/503`)).reason).toBe('provider_error');
    expect((await rerankVia(`http://127.0.0.1:${server.port}/400`)).reason).toBe('provider_error');
  });

  test('a healthy endpoint reranks and reports no failure', async () => {
    const { reason, out } = await rerankVia(`http://127.0.0.1:${server.port}/200`);
    expect(reason).toBeUndefined();
    expect(out.map(r => r.slug)).toEqual(['notes/c', 'notes/a', 'notes/b']);
  });

  test('a spend cap reports budget', async () => {
    let reason: RerankFailedReason | undefined;
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => applyReranker('which note', rows(), {
      enabled: true, topNIn: 30, topNOut: null,
      rerankerFn: async () => { throw new BudgetExhausted('spend cap reached', { reason: 'cost', spent: 1, cap: 1 }); },
      onFailure: (r) => { reason = r; },
    }));
    expect(reason).toBe('budget');
  });
});

describe('the held-out run, reproduced: a stale proxied reranker base URL', () => {
  test('hybridSearch with the reranker on and provider_base_urls.voyage on a dead port stamps rerank_failed: unreachable and keeps fused order', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-rerank-reason-home-'));
    const engine = new PGLiteEngine();
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: auditDir }, async () => {
        await engine.connect({});
        await engine.initSchema();
        for (const s of ['alpha', 'beta', 'gamma']) {
          await engine.putPage(`notes/${s}`, { type: 'note', title: s, compiled_truth: `shared keyword ${s}` });
          await installFixtureChunks(engine, `notes/${s}`, [{ chunk_index: 0, chunk_text: `shared keyword ${s}`, chunk_source: 'compiled_truth' }]);
        }
        configureGateway({
          embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
          env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'vk-test' },
          base_urls: { voyage: `http://127.0.0.1:${deadPort}/slot0/voyage/v1` },
        } as any);
        __setEmbedTransportForTests(async (args: any) => ({ embeddings: args.values.map(() => Array.from({ length: 1536 }, (_, j) => (j === 0 ? 1 : 0.01))) }) as any);
        let degraded: Array<{ stage: string; reason?: string }> = [];
        const out = await hybridSearch(engine, 'shared keyword', {
          limit: 10,
          reranker: { enabled: true, topNIn: 30, topNOut: null, model: 'voyage:rerank-2.5', timeoutMs: 5_000 },
          onMeta: (m) => { degraded = m.degraded ?? []; },
        });
        expect(out.length).toBe(3);
        expect(out.every(r => r.rerank_score === undefined)).toBe(true);
        expect(degraded).toContainEqual({ stage: 'rerank_failed', reason: 'unreachable' });
      });
    } finally {
      await engine.disconnect();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
