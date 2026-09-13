/**
 * T6 — NamedThingBench hermetic gate. Seeds a synthetic brain matching the
 * committed fixture (placeholder names) and runs the harness through the real
 * hybridSearch pipeline. The embed transport is stubbed to throw, forcing the
 * deterministic keyword + title-boost + alias-hop path (free, no network) — the
 * vector max-pool guarantee is pinned separately by searchvector-maxpool.test.ts.
 *
 * The corpus itself lives in test/fixtures/retrieval-quality/namedthing/corpus.ts
 * (shared with the paid R1 reranker A/B, scripts/r1-namedthing-rerank-ab.ts) so
 * the gate and the receipt describe the same brain.
 *
 * The gate MUST pass for the families that ARE the incident (title-substring,
 * alias-synonym, multi-chunk-dilution).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runRetrievalQuality, evaluateGate, type SearchFn } from '../src/eval/retrieval-quality/harness.ts';
import { loadNamedThingQuestions, seedNamedThingCorpus } from './fixtures/retrieval-quality/namedthing/corpus.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  // Force keyword + title + alias path: vector embed throws → hybrid falls open.
  __setEmbedTransportForTests(() => { throw new Error('stub: no embed in NamedThingBench test'); });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedNamedThingCorpus(engine);
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  await engine.disconnect();
});

describe('NamedThingBench gate (hermetic)', () => {
  test('the bug families pass the gate (title-substring, alias-synonym, dilution)', async () => {
    const questions = loadNamedThingQuestions();
    const searchFn: SearchFn = async (q) => {
      const rs = await hybridSearch(engine, q, { limit: 10, sourceId: 'default' });
      return rs.map(r => r.slug);
    };
    const report = await runRetrievalQuality(questions, searchFn);
    const gate = evaluateGate(report);

    // Diagnostic on failure: surface per-family rates.
    if (!gate.pass) {
      console.error('NamedThingBench families:', JSON.stringify(report.families, null, 2));
      console.error('breaches:', JSON.stringify(gate.breaches, null, 2));
    }
    expect(gate.pass).toBe(true);

    const byFam = new Map(report.families.map(f => [f.family, f]));
    expect(byFam.get('title-substring')!.hit_at_1).toBeGreaterThanOrEqual(0.95);
    expect(byFam.get('alias-synonym')!.hit_at_1).toBeGreaterThanOrEqual(0.98);
    expect(byFam.get('multi-chunk-dilution')!.hit_at_3).toBe(1.0);
  });

  test('hard-negative: the named projects do NOT surface for an unrelated query', async () => {
    const rs = await hybridSearch(engine, 'quarterly tax filing checklist', { limit: 10, sourceId: 'default' });
    const slugs = rs.map(r => r.slug);
    expect(slugs).not.toContain('projects/example-amphitheater');
    expect(slugs).not.toContain('projects/example-civic-platform');
  });
});
