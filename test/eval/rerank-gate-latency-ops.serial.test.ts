/**
 * W3 gate 4 latency runner end to end: `operationArmCaller` drives the real
 * `query` operation on a PGLite brain with the gate overlaid per arm, the
 * real gateway rerank path behind `__setRerankTransportForTests` (a fixed
 * 150 ms provider delay) and a deterministic embed transport.
 *
 * Protects: the `on` arm skips the provider on a strong vector grade and the
 * `off` arm calls it, the runner reads skips and eligibility from the
 * retrieval meta the operation emits, the saving lands on the skipped pairs
 * only, and the brain's own gate config is never written.
 * Fails when: the overlay does not reach the search config read, the meta
 * channel is not read, or the arms share state.
 * Serial: sets GBRAIN_HOME and the process-global gateway transports.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests, __setRerankTransportForTests } from '../../src/core/ai/gateway.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import { operationArmCaller, runPaired, summarizeLatency } from '../../src/eval/rerank-gate-latency.ts';
import { DIM, QUERY_DIM, seed } from '../helpers/rerank-gate-fixture.ts';

const PROVIDER_DELAY_MS = 150;
let engine: PGLiteEngine;
let home: string;
let prevHome: string | undefined;
let rerankCalls = 0;

beforeAll(async () => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-rrg-latency-'));
  process.env.GBRAIN_HOME = home;
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIM, env: { VOYAGE_API_KEY: 'vk-test-not-a-real-key', OPENAI_API_KEY: 'sk-test-not-a-real-key' } });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seed(engine);
  await engine.setConfig('search.reranker.enabled', 'true');
  __setEmbedTransportForTests((async (args: { values: string[] }) => ({
    embeddings: args.values.map((v) => {
      const query = Object.keys(QUERY_DIM).find((q) => v.includes(q));
      return Array.from(basisEmbedding(query ? QUERY_DIM[query] : 999, DIM));
    }),
  })) as never);
  __setRerankTransportForTests(async (_url: string, init: RequestInit) => {
    rerankCalls++;
    await new Promise((r) => setTimeout(r, PROVIDER_DELAY_MS));
    const body = JSON.parse(String(init.body)) as { documents: string[] };
    const data = body.documents.map((_, index) => ({ index, relevance_score: 1 - index * 0.01 }));
    return new Response(JSON.stringify({ object: 'list', data, model: 'rerank-2.5' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}, 120_000);

afterAll(async () => {
  __setRerankTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('operationArmCaller through the query operation', () => {
  test('a strong vector question skips under on and saves the provider time; a gap miss reranks in both arms', async () => {
    const ctx = {
      engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {}, debug() {} },
      dryRun: false, remote: false, sourceId: 'default',
    } as unknown as OperationContext;
    const items = [
      { id: 'strong', kind: 'single-hop', query: { query: 'orbital period of the gold probe', limit: 10, expand: false } },
      { id: 'gap', kind: 'multi-hop', query: { query: 'tidal locking near twins', limit: 10, expand: false } },
    ];
    const samples = await runPaired(items, operationArmCaller(ctx), { warmup: 0, repeats: 2, concurrency: 1 });
    expect(samples.filter((s) => s.error)).toEqual([]);
    const on = (id: string) => samples.filter((s) => s.arm === 'on' && s.id === id);
    expect(on('strong').every((s) => s.skipped === 1 && s.provider_calls === 0 && s.eligible === 1)).toBe(true);
    expect(on('gap').every((s) => s.skipped === 0 && s.provider_calls === 1)).toBe(true);
    expect(samples.filter((s) => s.arm === 'off').every((s) => s.skipped === 0)).toBe(true);
    // 2 repeats × (strong off + gap off + gap on): the skipped arm made no call.
    expect(rerankCalls).toBe(6);

    const report = summarizeLatency(samples);
    expect(report.pairs).toBe(4);
    expect(report.skipped_pairs).toBe(2);
    expect(report.by_kind['single-hop'].skipped).toBe(2);
    expect(report.reranker_calls).toEqual({ off: 4, on: 2, reduction: 0.5 });
    expect(report.mean_saving_per_skip_ms!).toBeGreaterThanOrEqual(PROVIDER_DELAY_MS * 0.8);
    expect(report.verdict.mean_saving_ok).toBe(true);
    expect(await engine.getConfig('search.reranker.gate')).toBeNull();
  });
});
