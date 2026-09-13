/**
 * Ranker wave (R1) — `search.relational_rerank_pin` end-to-end through
 * hybridSearch on the NamedThingBench relational corpus (hermetic).
 *
 * Reproduces the R1 receipt's mechanism with no network and no keys:
 *
 *   - in-memory PGLite seeded with test/fixtures/retrieval-quality/relational/
 *     corpus.ts (bodies never name the related entity — only the typed edge
 *     connects "who invested in widget-co" to its investors);
 *   - the query vector is aimed at EVERY company page (`queryEmbedFn`, the
 *     hermetic eval seam), so the pool is company-heavy — the receipt's shape;
 *   - the reranker is the REAL gateway path (`search.reranker.enabled` true in
 *     the balanced bundle → `gateway.rerank` → Voyage wire shape) behind the
 *     `__setRerankTransportForTests` seam, with a stub that deliberately
 *     INVERTS relevance for a relational question: company-shaped text 1.0,
 *     fund text 0.6, person text 0.2 (minus a tiny index tiebreak). That is
 *     what the receipt observed — the cross-encoder cannot see edges, so the
 *     pages that merely look like the question outrank the edge answers.
 *
 * Asserted: pin 0 (config `off` or per-call) reproduces the regression (gold
 * out of the top 3, one row rescued only by the #3995 evidence slot); the
 * default pin 3 keeps gold at rank 1 AND fills the top 3; text rows keep their
 * reranked order; autocut on text rows is unchanged; a non-relational query
 * is byte-identical for pin 3 vs 0; with the reranker off the pin is a no-op.
 *
 * .serial: sets GBRAIN_HOME + the process-global gateway config/transport seams.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway, __setRerankTransportForTests } from '../../src/core/ai/gateway.ts';
import {
  RELATIONAL_QUESTIONS,
  probeEmbeddingDim,
  relationalBasisEmbedding,
  seedRelationalCorpus,
} from '../fixtures/retrieval-quality/relational/corpus.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';

const DIMS = 1536;
const PIN_KEY = 'search.relational_rerank_pin';
const Q = 'who invested in widget-co';
const NON_RELATIONAL_Q = 'privately held company operating in its sector';

let engine: PGLiteEngine;
let queryVector: Float32Array;
let prevGbrainHome: string | undefined;
let isolatedHome: string;
const rerankCalls: Array<{ query: string; documents: string[] }> = [];

const COMPANIES = [...new Set(RELATIONAL_QUESTIONS.filter((q) => q.kind === 'who_rel').map((q) => q.seed).filter((s): s is string => typeof s === 'string'))];
const goldFor = (query: string): string[] => RELATIONAL_QUESTIONS.find((q) => q.query === query)!.relevant!;

/**
 * Inverted-relevance reranker (Voyage wire shape: `{object:'list', data:[{index,
 * relevance_score}]}`, sorted desc). Company text wins, funds next, people last —
 * the receipt's failure mode for a "who invested in …" question.
 */
async function invertedRerankTransport(_url: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body)) as { query: string; documents: string[] };
  rerankCalls.push({ query: body.query, documents: body.documents });
  const score = (doc: string, i: number): number =>
    (doc.includes('privately held company') ? 1.0 : doc.includes('venture fund') ? 0.6 : 0.2) - i * 1e-4;
  const data = body.documents
    .map((d, i) => ({ index: i, relevance_score: score(d, i) }))
    .sort((a, b) => b.relevance_score - a.relevance_score);
  return new Response(JSON.stringify({ object: 'list', data, model: 'rerank-2.5' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeAll(async () => {
  // Hermetic config home so a contributor's ~/.gbrain embedding_dimensions
  // can't outrank the 1536-d gateway stub (same idiom as
  // hybrid-reranker-integration.serial.test.ts, #1527).
  prevGbrainHome = process.env.GBRAIN_HOME;
  isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-rrp-home-'));
  process.env.GBRAIN_HOME = isolatedHome;

  // VOYAGE_API_KEY in the gateway env snapshot only (never process.env): the
  // v0.48.2 no_key preflight must pass so the REAL rerank() path reaches the
  // transport seam; the value is never sent anywhere.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { VOYAGE_API_KEY: 'vk-test-not-a-real-key' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const dim = await probeEmbeddingDim(engine);
  await seedRelationalCorpus(engine);

  // Aim the query vector at every company page with DISTINCT weights so the
  // vector arm's order is tie-free and runs are byte-reproducible.
  queryVector = new Float32Array(dim);
  COMPANIES.forEach((slug, i) => {
    const b = relationalBasisEmbedding(slug, dim);
    for (let j = 0; j < dim; j++) queryVector[j] += (1 + i * 0.05) * b[j];
  });

  __setRerankTransportForTests(invertedRerankTransport);
}, 120_000);

afterAll(async () => {
  __setRerankTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (prevGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevGbrainHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

type Run = { results: SearchResult[]; meta: HybridSearchMeta | undefined; slugs: string[] };

async function run(query: string, perCall: { relationalRerankPin?: number; autocut?: boolean } = {}): Promise<Run> {
  let meta: HybridSearchMeta | undefined;
  const results = await hybridSearch(engine, query, {
    limit: 10,
    sourceId: 'default',
    queryEmbedFn: () => queryVector,
    onMeta: (m) => { meta = m; },
    // Autocut is OFF in every bundle since rule R2; this file pins the pin's
    // contract THROUGH autocut (pinned rows survive the cut, text-row autocut
    // is byte-identical), so it turns autocut on per call explicitly.
    autocut: true,
    ...perCall,
  });
  return { results, meta, slugs: results.map((r) => r.slug) };
}

/** Everything a caller can observe about ranking, for byte-identity checks. */
const shape = (rs: SearchResult[]): string =>
  JSON.stringify(rs.map((r) => ({
    slug: r.slug, chunk_id: r.chunk_id, score: r.score,
    rerank_score: r.rerank_score ?? null, pinned: r.relational_pinned ?? null,
  })));

const degradedStages = (meta: HybridSearchMeta | undefined): string[] => (meta?.degraded ?? []).map((d) => d.stage);

describe('R1 regression reproduced with the pin OFF (inverted-relevance reranker, balanced default otherwise)', () => {
  test('who invested in widget-co: the reranker ran and demoted every edge answer out of the top 3; only the #3995 slot rescues one row at the page-1 tail', async () => {
    const before = rerankCalls.length;
    const off = await run(Q, { relationalRerankPin: 0 });
    const gold = goldFor(Q);

    // The REAL gateway rerank path ran (transport hit, scores stamped, no skip / pass-through).
    expect(rerankCalls.length).toBe(before + 1);
    expect(rerankCalls[rerankCalls.length - 1].query).toBe(Q);
    expect(off.results.some((r) => Number.isFinite(r.rerank_score))).toBe(true);
    expect(degradedStages(off.meta)).not.toContain('reranker_skipped');
    expect(degradedStages(off.meta)).not.toContain('rerank_passthrough');

    // hit@1 and hit@3 lost — company-shaped text outranks the investors.
    expect(gold).not.toContain(off.slugs[0]);
    expect(off.slugs.slice(0, 3).filter((s) => gold.includes(s))).toEqual([]);
    // No pin decision at pin 0 and no row stamped.
    expect(off.meta?.relational_rerank_pin).toBeUndefined();
    expect(off.results.some((r) => r.relational_pinned)).toBe(false);
    // The evidence slot is the only thing keeping ANY gold on page 1 — one row, deep.
    expect(off.meta?.relational_evidence_slot).toBeDefined();
    const goldOnPage = off.slugs.filter((s) => gold.includes(s));
    expect(goldOnPage.length).toBe(1);
    expect(off.slugs.indexOf(goldOnPage[0])).toBeGreaterThanOrEqual(3);
  });
});

describe('default balanced path (pin 3) — relational rows bypass reranker demotion', () => {
  test('gold at rank 1 and ALL gold in the top 3; pinned rows keep rerank_score; text rows keep their reranked order; text-row autocut unchanged', async () => {
    const gold = goldFor(Q);
    const off = await run(Q, { relationalRerankPin: 0 });
    const on = await run(Q);

    expect(gold).toContain(on.slugs[0]);
    expect(new Set(on.slugs.slice(0, 3))).toEqual(new Set(gold));

    const decision = on.meta?.relational_rerank_pin;
    expect(decision).toBeDefined();
    expect(decision!.max).toBe(3);
    expect(decision!.relational_in_pool).toBe(3);
    expect(decision!.pinned.map((p) => p.slug).sort()).toEqual([...gold].sort());
    expect(decision!.pinned.map((p) => p.to_rank)).toEqual([0, 1, 2]);
    for (const p of decision!.pinned) expect(p.from_rank).toBeGreaterThanOrEqual(3); // all were demoted
    expect(decision!.moved).toBe(3);

    for (const r of on.results.slice(0, 3)) {
      expect(r.relational_pinned).toBe(true);
      expect(Number.isFinite(r.rerank_score)).toBe(true); // score kept for --explain
    }
    expect(on.results.slice(3).some((r) => r.relational_pinned)).toBe(false);
    // The evidence slot has nothing left to do.
    expect(on.meta?.relational_evidence_slot).toBeUndefined();

    // Text rows: the SAME reranked order as the pin-0 run (a prefix — the
    // block takes 3 of the 10 page-1 slots).
    const onText = on.slugs.filter((s) => !gold.includes(s));
    const offText = off.slugs.filter((s) => !gold.includes(s));
    expect(onText.length).toBeGreaterThan(0);
    expect(offText.slice(0, onText.length)).toEqual(onText);

    // Autocut kept exactly the same text rows plus the 3 preserved pinned rows.
    expect(on.meta?.autocut).toBeDefined();
    expect(off.meta?.autocut).toBeDefined();
    expect(on.meta!.autocut!.kept - off.meta!.autocut!.kept).toBe(3);
  });

  test('max 1 pins one gold row at rank 1; the rest of page 1 is the reranked order', async () => {
    const gold = goldFor(Q);
    const one = await run(Q, { relationalRerankPin: 1 });
    expect(gold).toContain(one.slugs[0]);
    expect(one.meta?.relational_rerank_pin?.pinned.length).toBe(1);
    expect(one.results.filter((r) => r.relational_pinned).length).toBe(1);
    expect(gold).not.toContain(one.slugs[1]);
  });

  test('config key and per-call seam agree: off → regression; 3 → fixed; per-call beats config; invalid config → bundle default; unset → 3', async () => {
    const gold = goldFor(Q);
    try {
      await engine.setConfig(PIN_KEY, 'off');
      const viaOff = await run(Q);
      expect(gold).not.toContain(viaOff.slugs[0]);
      expect(viaOff.meta?.relational_rerank_pin).toBeUndefined();

      // Per-call wins over the config off.
      const perCall = await run(Q, { relationalRerankPin: 3 });
      expect(gold).toContain(perCall.slugs[0]);
      expect(perCall.meta?.relational_rerank_pin?.max).toBe(3);

      await engine.setConfig(PIN_KEY, '3');
      expect(gold).toContain((await run(Q)).slugs[0]);

      // Out-of-range config is ignored → bundle default (3), not "off".
      await engine.setConfig(PIN_KEY, '42');
      expect((await run(Q)).meta?.relational_rerank_pin?.max).toBe(3);

      // Invalid per-call value ≡ unset → the config value applies.
      await engine.setConfig(PIN_KEY, 'off');
      expect((await run(Q, { relationalRerankPin: Number.NaN })).meta?.relational_rerank_pin).toBeUndefined();
      expect((await run(Q, { relationalRerankPin: -1 })).meta?.relational_rerank_pin).toBeUndefined();
    } finally {
      await engine.unsetConfig(PIN_KEY);
    }
    expect((await run(Q)).meta?.relational_rerank_pin?.max).toBe(3);
  });
});

describe('pure no-op paths (byte-identical results)', () => {
  test('a non-relational query: pin 3 vs pin 0 identical, reranker ran, no decision stamped', async () => {
    const a = await run(NON_RELATIONAL_Q, { relationalRerankPin: 3 });
    const b = await run(NON_RELATIONAL_Q, { relationalRerankPin: 0 });
    expect(a.results.length).toBeGreaterThan(0);
    expect(a.results.some((r) => Number.isFinite(r.rerank_score))).toBe(true);
    expect(shape(a.results)).toBe(shape(b.results));
    expect(a.meta?.relational_rerank_pin).toBeUndefined();
    expect(b.meta?.relational_rerank_pin).toBeUndefined();
    expect(a.results.some((r) => r.relational_pinned)).toBe(false);
  });

  test('reranker off (config): the pin is a no-op — pin 3 vs pin 0 identical, no rerank call, fused order untouched', async () => {
    try {
      await engine.setConfig('search.reranker.enabled', 'false');
      const before = rerankCalls.length;
      const a = await run(Q, { relationalRerankPin: 3 });
      const b = await run(Q, { relationalRerankPin: 0 });
      expect(rerankCalls.length).toBe(before);
      expect(a.results.some((r) => Number.isFinite(r.rerank_score))).toBe(false);
      expect(shape(a.results)).toBe(shape(b.results));
      expect(a.meta?.relational_rerank_pin).toBeUndefined();
      expect(a.results.some((r) => r.relational_pinned)).toBe(false);
    } finally {
      await engine.unsetConfig('search.reranker.enabled');
    }
  });
});

describe('R1 paired shape across every "who invested in" question', () => {
  test('with the pin every question keeps hit@1 and fills hit@3 with gold; without it every question loses hit@1', async () => {
    const questions = RELATIONAL_QUESTIONS.filter((q) => q.query.startsWith('who invested in'));
    expect(questions.length).toBe(8);
    const rows: string[] = [];
    let onHit1 = 0, offHit1 = 0, onTop3AllGold = 0;
    for (const q of questions) {
      const gold = q.relevant!;
      const on = await run(q.query);
      const off = await run(q.query, { relationalRerankPin: 0 });
      const onHit = gold.includes(on.slugs[0]);
      const offHit = gold.includes(off.slugs[0]);
      const k = Math.min(3, gold.length);
      const top3Gold = on.slugs.slice(0, k).every((s) => gold.includes(s));
      if (onHit) onHit1++;
      if (offHit) offHit1++;
      if (top3Gold) onTop3AllGold++;
      rows.push(`${q.query}: ON ${on.slugs.slice(0, 3).join(',')} | OFF ${off.slugs.slice(0, 3).join(',')}`);
    }
    const table = rows.join('\n');
    expect(onHit1, table).toBe(questions.length);
    expect(onTop3AllGold, table).toBe(questions.length);
    expect(offHit1, table).toBe(0);
  }, 120_000);
});
