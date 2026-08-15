/**
 * v0.40.1.0 Track D / T5 — Hermetic retrieval qrels gate.
 *
 * Gates PRs touching src/core/search/** against a hand-curated qrels fixture
 * (test/fixtures/eval-baselines/qrels-search.json). Fully hermetic via basis-
 * vector embeddings — no API keys, no DATABASE_URL, no network.
 *
 * This is the structural-fix replacement for the original Task 2 design
 * (eval replay against captured eval_candidates), which Codex caught as
 * non-functional in CI (eval-export bypasses op-layer capture; replay
 * re-embeds queries via gateway which needs an API key). The qrels approach
 * tests retrieval QUALITY directly, not stability.
 *
 * Refresh procedure: when ranking changes are intentional, edit qrels-search.json
 * with a `Why:` line in the commit body (D4 convention). Do NOT silently
 * rubber-stamp baseline drift.
 *
 * Env overrides (via withEnv() per CLAUDE.md R1):
 *   GBRAIN_REPLAY_GATE_TOP1_FLOOR   (default 0.80)
 *   GBRAIN_REPLAY_GATE_RECALL_FLOOR (default 0.85)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import type { ChunkInput } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Canonical PGLite block (CLAUDE.md R3+R4)
// ---------------------------------------------------------------------------

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// ---------------------------------------------------------------------------
// Fixture loader + helpers
// ---------------------------------------------------------------------------

interface QrelQuery {
  query_id: string;
  query: string;
  /** Basis-vector dimension this query embeds at — same dim as first_relevant_slug. */
  embedding_dim: number;
  relevant_slugs: string[];
  first_relevant_slug: string;
}

interface QrelFixture {
  schema_version: 1;
  queries: QrelQuery[];
}

function loadFixture(): QrelFixture {
  const path = join(import.meta.dir, 'fixtures', 'eval-baselines', 'qrels-search.json');
  const fix = JSON.parse(readFileSync(path, 'utf8')) as QrelFixture;
  return fix;
}

/** Basis vector with 1.0 at `idx` and 0.0 elsewhere. Mirrors search-quality.test.ts. */
function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

/**
 * Seed each relevant slug with a chunk whose embedding aligns with the
 * query's basis dimension. The FIRST relevant slug gets a stronger signal
 * (compiled_truth) so it ranks top-1; subsequent relevant slugs get timeline
 * chunks at the same direction so they appear in top-K recall but not top-1.
 *
 * Non-relevant slugs from OTHER queries serve as noise — they're at
 * different basis dimensions so they orthogonally don't match.
 */
async function seedCorpus(fix: QrelFixture): Promise<void> {
  const seenSlugs = new Set<string>();
  for (const q of fix.queries) {
    for (let i = 0; i < q.relevant_slugs.length; i++) {
      const slug = q.relevant_slugs[i];
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      // First relevant: top-1 should win, so embed at THIS query's dim with
      // chunk_source=compiled_truth (gets the source boost). Subsequent
      // relevant slugs use timeline source so they outrank pure noise but
      // don't beat the first relevant.
      const isFirst = slug === q.first_relevant_slug;
      const isPersonOrCompany = slug.startsWith('people/') || slug.startsWith('companies/');
      await engine.putPage(slug, {
        type: isPersonOrCompany ? (slug.startsWith('people/') ? 'person' : 'company') : 'note',
        title: slug.split('/').pop() ?? slug,
        compiled_truth: isFirst ? `Primary content about ${q.query}` : '',
        timeline: !isFirst ? `Mentioned in context of ${q.query}` : '',
      });
      const chunk: ChunkInput = {
        chunk_index: 0,
        chunk_text: isFirst
          ? `Primary content about ${q.query}`
          : `Mentioned in context of ${q.query}`,
        chunk_source: isFirst ? 'compiled_truth' : 'timeline',
        embedding: basisEmbedding(q.embedding_dim),
        token_count: 10,
      };
      await engine.upsertChunks(slug, [chunk]);
    }
  }
}

/**
 * Run all qrels queries against the seeded engine, compute top-1 match rate
 * and recall@10. Pure data: returns the two metrics so the gate logic stays
 * separate from the measurement logic.
 */
async function measureGate(
  fix: QrelFixture,
): Promise<{ top1Rate: number; recallAt10: number; perQuery: Array<{ id: string; top1Match: boolean; recall: number }> }> {
  let top1Hits = 0;
  let recallSum = 0;
  const perQuery: Array<{ id: string; top1Match: boolean; recall: number }> = [];
  for (const q of fix.queries) {
    const results = await engine.searchVector(basisEmbedding(q.embedding_dim), { limit: 10 });
    const top1Slug = results[0]?.slug;
    const top1Match = top1Slug === q.first_relevant_slug;
    if (top1Match) top1Hits++;
    const retrievedSlugs = new Set(results.map(r => r.slug));
    const relevantInTop10 = q.relevant_slugs.filter(s => retrievedSlugs.has(s)).length;
    const recall = q.relevant_slugs.length === 0 ? 0 : relevantInTop10 / q.relevant_slugs.length;
    recallSum += recall;
    perQuery.push({ id: q.query_id, top1Match, recall });
  }
  return {
    top1Rate: top1Hits / fix.queries.length,
    recallAt10: recallSum / fix.queries.length,
    perQuery,
  };
}

// ---------------------------------------------------------------------------
// Constants (env-overridable)
// ---------------------------------------------------------------------------

const DEFAULT_TOP1_FLOOR = 0.80;
const DEFAULT_RECALL_FLOOR = 0.85;

function resolveFloors(): { top1: number; recall: number } {
  const t = process.env.GBRAIN_REPLAY_GATE_TOP1_FLOOR;
  const r = process.env.GBRAIN_REPLAY_GATE_RECALL_FLOOR;
  return {
    top1: t !== undefined ? Number(t) : DEFAULT_TOP1_FLOOR,
    recall: r !== undefined ? Number(r) : DEFAULT_RECALL_FLOOR,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('eval replay gate — hermetic retrieval qrels (v0.40.1.0 Track D / T5)', () => {
  test('current ranking meets default floors (top1 >= 0.80 AND recall@10 >= 0.85)', async () => {
    const fix = loadFixture();
    await seedCorpus(fix);
    const { top1Rate, recallAt10, perQuery } = await measureGate(fix);
    const { top1, recall } = resolveFloors();

    // Surface per-query results when the gate trips so the operator sees which
    // queries regressed without re-running with --verbose.
    if (top1Rate < top1 || recallAt10 < recall) {
      process.stderr.write(`[eval replay gate] BREACH:\n`);
      process.stderr.write(`  top1=${top1Rate.toFixed(3)} (floor ${top1.toFixed(3)})\n`);
      process.stderr.write(`  recall@10=${recallAt10.toFixed(3)} (floor ${recall.toFixed(3)})\n`);
      for (const q of perQuery) {
        process.stderr.write(`    ${q.id}: top1=${q.top1Match ? 'HIT' : 'miss'} recall=${q.recall.toFixed(2)}\n`);
      }
    }

    expect(top1Rate).toBeGreaterThanOrEqual(top1);
    expect(recallAt10).toBeGreaterThanOrEqual(recall);
  });

  test('env-overridable floors via GBRAIN_REPLAY_GATE_TOP1_FLOOR / GBRAIN_REPLAY_GATE_RECALL_FLOOR', async () => {
    const fix = loadFixture();
    await seedCorpus(fix);

    // Set an impossible-to-meet floor and verify the resolver picks it up.
    // We don't ASSERT failure here (that would make the test flaky against
    // any future ranking improvement); we just assert the resolver respects
    // env vars.
    await withEnv({ GBRAIN_REPLAY_GATE_TOP1_FLOOR: '0.999', GBRAIN_REPLAY_GATE_RECALL_FLOOR: '0.999' }, async () => {
      const { top1, recall } = resolveFloors();
      expect(top1).toBeCloseTo(0.999, 3);
      expect(recall).toBeCloseTo(0.999, 3);
    });

    // After exit, defaults restored.
    const { top1, recall } = resolveFloors();
    expect(top1).toBeCloseTo(DEFAULT_TOP1_FLOOR, 3);
    expect(recall).toBeCloseTo(DEFAULT_RECALL_FLOOR, 3);
  });

  test('seeded corpus produces deterministic top-1 results (gate sanity)', async () => {
    const fix = loadFixture();
    await seedCorpus(fix);
    // Run twice; same fixture must produce same per-query top-1.
    const a = await measureGate(fix);
    const b = await measureGate(fix);
    expect(a.top1Rate).toBe(b.top1Rate);
    expect(a.recallAt10).toBe(b.recallAt10);
    for (let i = 0; i < a.perQuery.length; i++) {
      expect(a.perQuery[i]).toEqual(b.perQuery[i]);
    }
  });

  test('fixture schema sanity — every query has required fields', () => {
    const fix = loadFixture();
    expect(fix.schema_version).toBe(1);
    expect(fix.queries.length).toBeGreaterThanOrEqual(10);
    for (const q of fix.queries) {
      expect(typeof q.query_id).toBe('string');
      expect(typeof q.query).toBe('string');
      expect(typeof q.embedding_dim).toBe('number');
      expect(Array.isArray(q.relevant_slugs)).toBe(true);
      expect(q.relevant_slugs.length).toBeGreaterThan(0);
      expect(q.relevant_slugs).toContain(q.first_relevant_slug);
    }
  });

  test('no real names in qrels fixture (CLAUDE.md privacy rule)', () => {
    // Smoke-grep: scan the fixture for known-real-name patterns. This is a
    // belt-and-suspenders check beyond scripts/check-privacy.sh.
    const raw = readFileSync(
      join(import.meta.dir, 'fixtures', 'eval-baselines', 'qrels-search.json'),
      'utf8',
    );
    // Block list — names that appeared in older E2E fixtures and were
    // explicitly called out by Codex (#9) as privacy-violating.
    const blockList = ['Pedro Franceschi', 'Brex', 'Wintermute', 'Garry Tan', 'Y Combinator', 'YC'];
    for (const name of blockList) {
      expect(raw).not.toContain(name);
    }
  });
});
