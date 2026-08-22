/**
 * Relational recall arm integration tests (PGLite, default CI).
 *
 * End-to-end through buildRelationalArm: parse → resolve seed → fanout →
 * hydrate. Pins the lexically-unrecoverable win (the investor page never names
 * the company; only the invested_in edge connects them), the non-relational
 * no-op, attribution stamping, and fail-open.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildRelationalArm, ensureRelationalEvidenceSlot } from '../src/core/search/relational-recall.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { probeEmbeddingDim } from './fixtures/retrieval-quality/relational/corpus.ts';
import type { ChunkInput, SearchResult, HybridSearchMeta } from '../src/core/types.ts';

let eng: PGLiteEngine;

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();
  const dim = await probeEmbeddingDim(eng); // match schema column width (1280 ZE / 1536 OpenAI)

  await eng.putPage('companies/widget-co', { type: 'company', title: 'Widget Co', compiled_truth: 'A payments company.', timeline: '' });
  // The investor's body deliberately NEVER mentions Widget Co — only the edge connects them.
  await eng.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice is a seed-stage investor based in Lisbon.', timeline: '' });
  await eng.upsertChunks('people/alice-example', [{
    chunk_index: 0, chunk_text: 'Alice is a seed-stage investor based in Lisbon.',
    chunk_source: 'compiled_truth', embedding: new Float32Array(dim), token_count: 8,
  }] satisfies ChunkInput[]);
  await eng.addLink('people/alice-example', 'companies/widget-co', '', 'invested_in', 'manual');

  // #4352 fixture: a `visibility: private` investor whose ONLY connection to
  // the company is the typed edge. Pre-remediation the arm hydrated its title
  // + compiled_truth snippet for ANY caller (hybrid.ts built the arm without
  // excludePrivate; hydrate() filtered on deleted_at alone).
  await eng.putPage('people/mallory-secret', {
    type: 'person', title: 'Mallory Secret',
    frontmatter: { visibility: 'private' },
    compiled_truth: 'Mallory runs a stealth family office in Zurich.', timeline: '',
  });
  await eng.addLink('people/mallory-secret', 'companies/widget-co', '', 'invested_in', 'manual');
}, 60_000);

afterAll(async () => { await eng.disconnect(); });

describe('buildRelationalArm', () => {
  test('surfaces the edge answer that lexical search would miss', async () => {
    const list = await buildRelationalArm(eng, 'who invested in widget-co');
    const alice = list.find(r => r.slug === 'people/alice-example');
    expect(alice).toBeDefined();
    expect(alice!.relational_via_link_types).toEqual(['invested_in']);
    expect(alice!.relational_hop).toBe(1);
    expect(alice!.relational_seed).toBe('companies/widget-co');
    // chunk-backed page → reinforces a REAL chunk id (not synthetic 0).
    expect(alice!.chunk_id).toBeGreaterThan(0);
  });

  test('non-relational query is a pure no-op', async () => {
    const meta: { fired?: boolean } = {};
    const list = await buildRelationalArm(eng, 'summary of the payments roadmap', { onMeta: m => { meta.fired = m.fired; } });
    expect(list).toEqual([]);
    expect(meta.fired).toBe(false);
  });

  test('unresolvable seed → no-op (never traverse from a guess)', async () => {
    const list = await buildRelationalArm(eng, 'who invested in nonexistent-phantom-xyz');
    expect(list).toEqual([]);
  });

  test('#4352: excludePrivate hides private pages from the arm; default keeps them (trusted)', async () => {
    const trusted = await buildRelationalArm(eng, 'who invested in widget-co');
    expect(trusted.map(r => r.slug)).toContain('people/mallory-secret');

    const gated = await buildRelationalArm(eng, 'who invested in widget-co', { excludePrivate: true });
    const slugs = gated.map(r => r.slug);
    expect(slugs).not.toContain('people/mallory-secret');
    expect(slugs).toContain('people/alice-example'); // non-private candidates survive
    // Neither the private title nor the compiled_truth snippet leaks anywhere.
    for (const r of gated) {
      expect(r.title).not.toContain('Mallory');
      expect(r.chunk_text).not.toContain('stealth family office');
    }
  });

  test('#4352: hybridSearch threads excludePrivate into the relational arm', async () => {
    const remoteLike = await hybridSearch(eng, 'who invested in widget-co', {
      relationalRetrieval: true, excludePrivate: true, limit: 20,
    });
    const remoteSlugs = remoteLike.map(r => r.slug);
    expect(remoteSlugs).not.toContain('people/mallory-secret');
    expect(remoteSlugs).toContain('people/alice-example');

    const localLike = await hybridSearch(eng, 'who invested in widget-co', {
      relationalRetrieval: true, limit: 20,
    });
    expect(localLike.map(r => r.slug)).toContain('people/mallory-secret');
  });

  test('#4352: hydrate hides pages in archived sources (all callers)', async () => {
    await eng.executeRaw(`UPDATE sources SET archived = true WHERE id = 'default'`, []);
    try {
      const list = await buildRelationalArm(eng, 'who invested in widget-co');
      expect(list).toEqual([]);
    } finally {
      await eng.executeRaw(`UPDATE sources SET archived = false WHERE id = 'default'`, []);
    }
  });

  test('fail-open: fanout error returns [] + errored meta, never throws', async () => {
    const original = eng.relationalFanout.bind(eng);
    let captured: { errored?: boolean } = {};
    eng.relationalFanout = async () => { throw new Error('boom'); };
    try {
      const list = await buildRelationalArm(eng, 'who invested in widget-co', { onMeta: m => { captured = m; } });
      expect(list).toEqual([]);
      expect(captured.errored).toBe(true);
    } finally {
      eng.relationalFanout = original;
    }
  });
});

// ---------------------------------------------------------------------------
// #3995 — guaranteed page-1 relational evidence slot
// ---------------------------------------------------------------------------

function mk(slug: string, score: number, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    slug, page_id: 1, title: slug, type: 'note',
    chunk_text: slug, chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0,
    score, stale: false, source_id: 'default', ...extra,
  } as SearchResult;
}

describe('ensureRelationalEvidenceSlot (unit, #3995)', () => {
  const rel = [mk('people/alice-example', 0, { relational_seed: 'companies/widget-co' })];

  test('no-op when a relational page is already inside the limit window', () => {
    const pool = [mk('a', 0.9), mk('people/alice-example', 0.8), mk('b', 0.7)];
    const r = ensureRelationalEvidenceSlot(pool, rel, 2, 0);
    expect(r.decision).toBeUndefined();
    expect(r.pool).toBe(pool); // untouched reference on no-op
  });

  test('fusion overflow: promotes the fused relational row into slot limit-1', () => {
    const pool = [mk('a', 0.9), mk('b', 0.8), mk('c', 0.7), mk('people/alice-example', 0.1), mk('d', 0.05)];
    const r = ensureRelationalEvidenceSlot(pool, rel, 3, 0);
    expect(r.decision).toEqual({ action: 'promoted', slug: 'people/alice-example', source_id: 'default', from_rank: 3 });
    expect(r.pool.slice(0, 3).map(x => x.slug)).toEqual(['a', 'b', 'people/alice-example']);
    // promoted row keeps its real fused score; input pool not mutated
    expect(r.pool[2].score).toBe(0.1);
    expect(pool[3].slug).toBe('people/alice-example');
    expect(r.pool.length).toBe(pool.length);
  });

  test('autocut drop: injects relationalList[0] at slot limit-1 when absent from pool', () => {
    const pool = [mk('a', 0.9), mk('b', 0.8), mk('c', 0.7)];
    const r = ensureRelationalEvidenceSlot(pool, rel, 3, 0);
    expect(r.decision).toEqual({ action: 'injected', slug: 'people/alice-example', source_id: 'default' });
    expect(r.pool.map(x => x.slug)).toEqual(['a', 'b', 'people/alice-example', 'c']);
    // injected score-0 row is clamped just below its predecessor (monotone order)
    expect(r.pool[2].score).toBeLessThanOrEqual(r.pool[1].score);
    expect(r.pool[2].score).toBeGreaterThan(0);
  });

  test('injection appends when the pool is shorter than the limit', () => {
    const pool = [mk('a', 0.9)];
    const r = ensureRelationalEvidenceSlot(pool, rel, 5, 0);
    expect(r.decision?.action).toBe('injected');
    expect(r.pool.map(x => x.slug)).toEqual(['a', 'people/alice-example']);
  });

  test('offset > 0 is a pure no-op (first page only)', () => {
    const pool = [mk('a', 0.9), mk('b', 0.8), mk('c', 0.7)];
    const r = ensureRelationalEvidenceSlot(pool, rel, 2, 2);
    expect(r.decision).toBeUndefined();
    expect(r.pool).toBe(pool);
  });

  test('empty relational arm is a pure no-op', () => {
    const pool = [mk('a', 0.9)];
    const r = ensureRelationalEvidenceSlot(pool, [], 2, 0);
    expect(r.decision).toBeUndefined();
    expect(r.pool).toBe(pool);
  });

  test('page-level match counts any chunk of the relational page', () => {
    // same page surfaced by keyword under a DIFFERENT chunk id → still evidence
    const pool = [mk('a', 0.9), mk('people/alice-example', 0.8, { chunk_id: 42 })];
    const r = ensureRelationalEvidenceSlot(pool, rel, 2, 0);
    expect(r.decision).toBeUndefined();
  });
});

describe('hybridSearch guarantees page-1 relational evidence (#3995)', () => {
  let eng2: PGLiteEngine;

  beforeAll(async () => {
    eng2 = new PGLiteEngine();
    await eng2.connect({});
    await eng2.initSchema();
    // Deterministic no-embedding-provider install (noEmbed path).
    configureGateway({ env: {} });

    await eng2.putPage('companies/widget-co', { type: 'company', title: 'Widget Co', compiled_truth: 'A payments company.', timeline: '' });
    // Relational answer: unverified auto-extracted stub (no compiled-truth
    // boost) whose body never contains the query tokens — the #3995 shape.
    await eng2.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example',
      compiled_truth: 'Alice is a seed-stage backer based in Lisbon.', timeline: '',
      frontmatter: { provenance: 'auto-extracted', status: 'unverified' },
    });
    await eng2.upsertChunks('people/alice-example', [{
      chunk_index: 0, chunk_text: 'Alice is a seed-stage backer based in Lisbon.',
      chunk_source: 'compiled_truth', token_count: 8,
    }] as ChunkInput[]);
    await eng2.addLink('people/alice-example', 'companies/widget-co', '', 'invested_in', 'manual');

    // Verified keyword noise that outranks the single-arm relational row.
    for (let i = 0; i < 12; i++) {
      const slug = `notes/noise-${i}`;
      const text = `Fund memo ${i}: somebody invested in widget-co adjacent themes.`;
      await eng2.putPage(slug, { type: 'note', title: `Noise ${i}`, compiled_truth: text, timeline: '' });
      await eng2.upsertChunks(slug, [{
        chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 12,
      }] as ChunkInput[]);
    }
  }, 60_000);

  afterAll(async () => {
    resetGateway();
    await eng2.disconnect();
  });

  test('limit slice would drop the fired arm evidence — slot keeps it on page 1', async () => {
    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearch(eng2, 'who invested in widget-co', {
      limit: 2, relationalRetrieval: true, expansion: false, onMeta: m => { meta = m; },
    });
    expect(results.length).toBe(2);
    expect(results.some(r => r.slug === 'people/alice-example')).toBe(true);
    expect(meta?.relational_evidence_slot?.action).toBe('promoted');
    expect(meta?.relational_evidence_slot?.slug).toBe('people/alice-example');
  }, 60_000);

  test('control: arm off → no slot, evidence page absent (proves non-lexical)', async () => {
    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearch(eng2, 'who invested in widget-co', {
      limit: 2, relationalRetrieval: false, expansion: false, onMeta: m => { meta = m; },
    });
    expect(results.some(r => r.slug === 'people/alice-example')).toBe(false);
    expect(meta?.relational_evidence_slot).toBeUndefined();
  }, 60_000);

  test('offset page: slot does not repeat the evidence row', async () => {
    let meta: HybridSearchMeta | undefined;
    await hybridSearch(eng2, 'who invested in widget-co', {
      limit: 2, offset: 2, relationalRetrieval: true, expansion: false, onMeta: m => { meta = m; },
    });
    expect(meta?.relational_evidence_slot).toBeUndefined();
  }, 60_000);

  test('evidence already on page 1 → clean run, no slot stamp', async () => {
    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearch(eng2, 'who invested in widget-co', {
      limit: 20, relationalRetrieval: true, expansion: false, onMeta: m => { meta = m; },
    });
    expect(results.some(r => r.slug === 'people/alice-example')).toBe(true);
    expect(meta?.relational_evidence_slot).toBeUndefined();
  }, 60_000);
});
