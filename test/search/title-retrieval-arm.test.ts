/**
 * fix/title-retrieval-arm — D1 title candidate arm + D2 AND→OR keyword fallback.
 *
 * The disease (3-lane diagnostic, 2026-07): page titles never enter the
 * keyword-searchable text. content_chunks.search_vector is doc_comment +
 * symbol_name_qualified + chunk_text — no title — so an exact-title query
 * whose tokens are absent from the body had ZERO keyword recall, and every
 * existing title mechanism (title boost, exact-match boost, alias hop) is
 * re-rank-only: none can GENERATE the missing candidate. Compounding it,
 * websearch_to_tsquery AND semantics at chunk grain meant one
 * non-co-occurring token zeroed the whole keyword arm with no fallback.
 *
 * Fixes under test:
 *   C1 — engine.searchTitles: page-grain candidates from pages.search_vector
 *        (title weight 'A'), joined to one representative chunk, fused into
 *        hybridSearch as a keyword-class RRF list. No query-length gate.
 *   C2 — searchKeyword retries ONCE with OR-of-terms when strict AND
 *        returns zero rows; strict results always win when non-empty.
 *
 * Hermetic PGLite. The gateway is pinned with an EMPTY env so embedding is
 * deterministically unavailable — hybridSearch takes the keyword(+title)
 * no-embed path with zero network, regardless of host API keys.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { buildOrFallbackWebsearchQuery } from '../../src/core/search/sql-ranking.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

const DIM = 1536;

beforeAll(async () => {
  // Pin 1536-d (matches the preload schema default) with an EMPTY env so
  // isAvailable('embedding') is false → hybridSearch never embeds.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  // Restore the preload-equivalent gateway for sibling files in this shard.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: { ...process.env },
  });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Page whose TITLE tokens never appear in its body/chunks (the D1 shape). */
async function seedTitleOnlyPage(): Promise<void> {
  await engine.putPage('projects/chronomancer', {
    type: 'note',
    title: 'Chronomancer Codex Ledger',
    compiled_truth: 'A reference document about scheduling practices and planning.',
  });
  await engine.upsertChunks('projects/chronomancer', [
    {
      chunk_index: 0,
      chunk_text: 'A reference document about scheduling practices and planning.',
      chunk_source: 'compiled_truth',
    },
  ]);
}

describe('searchTitles — D1 title candidate arm', () => {
  test('exact-title query retrieves a page whose title tokens are absent from its body', async () => {
    await seedTitleOnlyPage();

    // Premise check: the chunk-grain keyword arm CANNOT see this page for
    // this query, even with the OR fallback (no title token is in any chunk).
    const kw = await engine.searchKeyword('Chronomancer Codex Ledger', { limit: 10 });
    expect(kw.map(r => r.slug)).not.toContain('projects/chronomancer');

    // The title arm can.
    const hits = await engine.searchTitles('Chronomancer Codex Ledger', { limit: 10 });
    expect(hits.map(r => r.slug)).toContain('projects/chronomancer');
    const hit = hits.find(r => r.slug === 'projects/chronomancer')!;
    expect(hit.title).toBe('Chronomancer Codex Ledger');
    expect(hit.score).toBeGreaterThan(0);
    // Shaped like a keyword-arm row: representative chunk attached.
    expect(hit.chunk_text).toContain('reference document');
    expect(hit.chunk_source).toBe('compiled_truth');
  });

  test('long 10-content-token exact-title query still retrieves (no token-count gate)', async () => {
    const longTitle = 'Emerald Falcon Doctrine Quarterly Synthesis Report Alpha Bravo Charlie Delta';
    await engine.putPage('reports/emerald-falcon', {
      type: 'note',
      title: longTitle,
      compiled_truth: 'An annual planning artifact.',
    });
    await engine.upsertChunks('reports/emerald-falcon', [
      { chunk_index: 0, chunk_text: 'An annual planning artifact.', chunk_source: 'compiled_truth' },
    ]);

    const hits = await engine.searchTitles(longTitle, { limit: 10 });
    expect(hits.map(r => r.slug)).toContain('reports/emerald-falcon');
  });

  test('representative chunk prefers compiled_truth, else lowest chunk_index', async () => {
    await engine.putPage('notes/mixed-chunks', {
      type: 'note',
      title: 'Obsidian Waterfall Registry',
      compiled_truth: 'body text here',
    });
    await engine.upsertChunks('notes/mixed-chunks', [
      { chunk_index: 0, chunk_text: 'timeline entry text', chunk_source: 'timeline' },
      { chunk_index: 1, chunk_text: 'compiled body text', chunk_source: 'compiled_truth' },
    ]);
    const hits = await engine.searchTitles('Obsidian Waterfall Registry', { limit: 5 });
    const hit = hits.find(r => r.slug === 'notes/mixed-chunks')!;
    expect(hit.chunk_source).toBe('compiled_truth');
    expect(hit.chunk_index).toBe(1);

    await engine.putPage('notes/timeline-only', {
      type: 'note',
      title: 'Cobalt Meridian Atlas',
      compiled_truth: 'unrelated body',
    });
    await engine.upsertChunks('notes/timeline-only', [
      { chunk_index: 5, chunk_text: 'later timeline', chunk_source: 'timeline' },
      { chunk_index: 2, chunk_text: 'earlier timeline', chunk_source: 'timeline' },
    ]);
    const tlHits = await engine.searchTitles('Cobalt Meridian Atlas', { limit: 5 });
    const tlHit = tlHits.find(r => r.slug === 'notes/timeline-only')!;
    expect(tlHit.chunk_index).toBe(2); // lowest index when no compiled_truth chunk
  });

  test('respects soft-delete visibility and source scoping', async () => {
    await seedTitleOnlyPage();

    // Source scope that doesn't own the page → filtered out at SQL level.
    const scoped = await engine.searchTitles('Chronomancer Codex Ledger', {
      limit: 10,
      sourceId: 'some-other-source',
    });
    expect(scoped.length).toBe(0);

    // Soft-deleted pages disappear (visibility clause).
    await engine.softDeletePage('projects/chronomancer');
    const afterDelete = await engine.searchTitles('Chronomancer Codex Ledger', { limit: 10 });
    expect(afterDelete.map(r => r.slug)).not.toContain('projects/chronomancer');
  });

  test('respects hard-exclude slug prefixes (test/ is excluded by default)', async () => {
    await engine.putPage('test/hidden-fixture', {
      type: 'note',
      title: 'Zanzibar Protocol Manifest',
      compiled_truth: 'fixture body',
    });
    const hits = await engine.searchTitles('Zanzibar Protocol Manifest', { limit: 10 });
    expect(hits.map(r => r.slug)).not.toContain('test/hidden-fixture');
  });
});

describe('searchKeyword — D2 AND→OR fallback', () => {
  async function seedQuantumPage(): Promise<void> {
    await engine.putPage('notes/quantum', {
      type: 'note',
      title: 'Quantum Notes',
      compiled_truth: 'quantum lattice harmonics resonance experiments',
    });
    await engine.upsertChunks('notes/quantum', [
      {
        chunk_index: 0,
        chunk_text: 'quantum lattice harmonics resonance experiments',
        chunk_source: 'compiled_truth',
      },
    ]);
  }

  test('one bad token no longer zeroes keyword recall (orFallback: true rescues)', async () => {
    await seedQuantumPage();
    // Strict AND fails ('zzzmissingtoken' is nowhere); OR fallback rescues.
    const hits = await engine.searchKeyword('quantum lattice harmonics zzzmissingtoken', {
      limit: 10,
      orFallback: true,
    });
    expect(hits.map(r => r.slug)).toContain('notes/quantum');
  });

  test('WITHOUT the orFallback flag the one-bad-token query returns zero (F1: strict default)', async () => {
    await seedQuantumPage();
    // Precision consumers (countMentions, link-extraction, eval) call
    // searchKeyword without the flag — their strict-AND contract must hold.
    const hits = await engine.searchKeyword('quantum lattice harmonics zzzmissingtoken', { limit: 10 });
    expect(hits.length).toBe(0);
  });

  test('strict-AND results stay preferred: no OR dilution when AND matches', async () => {
    await seedQuantumPage();
    await engine.putPage('notes/partial', {
      type: 'note',
      title: 'Partial Overlap',
      compiled_truth: 'quantum computing conference recap',
    });
    await engine.upsertChunks('notes/partial', [
      { chunk_index: 0, chunk_text: 'quantum computing conference recap', chunk_source: 'compiled_truth' },
    ]);

    // All four tokens co-occur only in notes/quantum → strict AND non-empty
    // → the OR retry must NOT fire (even with the flag SET), so the
    // partial-overlap page stays out.
    const hits = await engine.searchKeyword('quantum lattice harmonics resonance', {
      limit: 10,
      orFallback: true,
    });
    expect(hits.map(r => r.slug)).toContain('notes/quantum');
    expect(hits.map(r => r.slug)).not.toContain('notes/partial');
  });

  test('single unmatched token returns empty (OR of one term is pointless)', async () => {
    await seedQuantumPage();
    const hits = await engine.searchKeyword('zzznothinghere', { limit: 10, orFallback: true });
    expect(hits.length).toBe(0);
  });
});

describe('buildOrFallbackWebsearchQuery — pure', () => {
  test('joins tokens with OR', () => {
    expect(buildOrFallbackWebsearchQuery('alpha beta')).toBe('alpha OR beta');
  });
  test('returns null for <2 tokens', () => {
    expect(buildOrFallbackWebsearchQuery('alpha')).toBeNull();
    expect(buildOrFallbackWebsearchQuery('')).toBeNull();
    expect(buildOrFallbackWebsearchQuery('  ')).toBeNull();
  });
  test('F3: refuses queries with websearch operators (negation must not resurrect)', () => {
    // A `-bar` exclusion relaxed to `foo OR bar` would MATCH the excluded
    // term; a quoted phrase would degrade to a bag of words. No fallback.
    expect(buildOrFallbackWebsearchQuery('foo -bar')).toBeNull();
    expect(buildOrFallbackWebsearchQuery('"alpha beta" gamma')).toBeNull();
    expect(buildOrFallbackWebsearchQuery('"alpha beta" -gamma')).toBeNull();
  });
  test('interior hyphens are not operators — still relaxed', () => {
    expect(buildOrFallbackWebsearchQuery('alpha-beta gamma')).toBe('alpha OR beta OR gamma');
  });
  test('drops literal OR/AND words so they cannot re-parse as operators', () => {
    expect(buildOrFallbackWebsearchQuery('alpha or beta')).toBe('alpha OR beta');
    expect(buildOrFallbackWebsearchQuery('alpha AND beta')).toBe('alpha OR beta');
    // Only operator words survive tokenization → nothing left to relax.
    expect(buildOrFallbackWebsearchQuery('or and')).toBeNull();
  });
});

describe('hybridSearch wiring — title arm reaches the fused result set', () => {
  test('exact-title query surfaces the page through hybridSearch (keyword-only path)', async () => {
    await seedTitleOnlyPage();
    const results = await hybridSearch(engine, 'Chronomancer Codex Ledger', { limit: 5 });
    expect(results.map(r => r.slug)).toContain('projects/chronomancer');
  });

  test('long exact-title query (>=8 content tokens) surfaces through hybridSearch', async () => {
    const longTitle = 'Emerald Falcon Doctrine Quarterly Synthesis Report Alpha Bravo Charlie Delta';
    await engine.putPage('reports/emerald-falcon', {
      type: 'note',
      title: longTitle,
      compiled_truth: 'An annual planning artifact.',
    });
    await engine.upsertChunks('reports/emerald-falcon', [
      { chunk_index: 0, chunk_text: 'An annual planning artifact.', chunk_source: 'compiled_truth' },
    ]);
    const results = await hybridSearch(engine, longTitle, { limit: 5 });
    expect(results.map(r => r.slug)).toContain('reports/emerald-falcon');
  });

  test('body-only queries still work (no regression from the extra arm)', async () => {
    await seedTitleOnlyPage();
    const results = await hybridSearch(engine, 'scheduling practices planning', { limit: 5 });
    expect(results.map(r => r.slug)).toContain('projects/chronomancer');
  });

  test('hybrid keyword arm still opts into the OR fallback (F1: QA-verified behavior preserved)', async () => {
    await seedTitleOnlyPage();
    // One bad token against body text: direct searchKeyword (no flag) finds
    // nothing, but hybridSearch sets orFallback for its recall arm.
    const q = 'scheduling practices zzzmissingtoken';
    expect((await engine.searchKeyword(q, { limit: 5 })).length).toBe(0);
    const results = await hybridSearch(engine, q, { limit: 5 });
    expect(results.map(r => r.slug)).toContain('projects/chronomancer');
  });
});
