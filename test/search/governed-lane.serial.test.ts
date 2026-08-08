/**
 * governed-source-lane — Slice-2 (hybridSearch composition) tests.
 *
 *   T13 — governed-lane-ON must SKIP the query cache (Option B: cache-skip,
 *         NOT a knobsHash fingerprint change). default-OFF preserves cache
 *         behavior and KNOBS_HASH_VERSION stays 15 (proves mode.ts unused).
 *
 *   T14 — Lane-B failure degrades to EXACT Lane-A: zero broadened governed
 *         contribution, legacy search succeeds (no throw). Anchored by a
 *         happy-path assertion (governed surfaces when the lane is ON and
 *         Lane-B succeeds). Per SL-184 the forced Lane-B searchVector error
 *         is exercised for EACH relevant engine path — PGLite always, and
 *         Postgres when DATABASE_URL is provided — so the degradation
 *         contract is proven on both engines that carry the restrict seam.
 *
 * Harness modeled on test/search/hybrid-reranker-integration.serial.test.ts
 * (offline embed stub + isolated GBRAIN_HOME + 1536d gateway pin). T13 is
 * engine-agnostic (cache behavior), so it runs on PGLite only.
 *
 * ── CodeGraph findings (already-completed; appended per SL-211 before T15) ──
 * BOUNDED-CONTEXT AUGMENTATION merge (PM resolution of note c; REJECT rank-0
 * pin): at most ONE deduplicated relevant governed candidate into a reserved
 * TAIL context slot when limit>=2 (replacing only the Lane-A tail if full);
 * preserve Lane-A top + relative order; limit<2 ⇒ Lane-A only. Lane-B admission
 * uses configurable `min_raw_score` in the RAW-COSINE domain, applied before
 * source-factor/merge (SQL on raw_score, both engines). Production default is
 * pilot-derived + configurable, NOT a hardcoded 0.30.
 *
 * Score-domain proof (source-cited, independently verified; Gemini G1/G2 corroborated):
 *  - raw_score = 1-(cc.col <=> q) ∈ [0,1] cosine (hnsw_candidates CTE; postgres
 *    2259 / pglite mirror). Caller `.score` = raw_score × sourceFactor (scored CTE
 *    2282→2295). raw_score NOT exposed; base_score = runPostFusionStages-only.
 *  - Lane-B = engine.searchVector(queryEmbedding, …) ⇒ Lane-B `.score` is raw×sourceFactor
 *    (NOT the Lane-A 0.7·normRrf+0.3·cosine blend at hybrid.ts:2298-2305, which is
 *    Lane-A fusion only). ⇒ floor on raw_score is correct for Lane-B.
 * Considered-and-REJECTED:
 *  - native `floorThreshold` reuse — NO retrieval-level min-score utility exists
 *    in gbrain (only scattered LOCAL heuristics: link-extraction 0.8, x-api 0.5/0.7,
 *    entities/resolve 0.7, telemetry 0.85). ⇒ new additive SearchOpts.min_raw_score.
 *  - ce_threshold as the floor — UDKB `ce_threshold=0.3` (adapters.py:244,
 *    knowledge_operator_tools.py:1114) is a SERVING/answer-layer cross-encoder gate,
 *    NOT a gbrain LANDING/retrieval threshold. Different layer; not reused. gbrain
 *    has NO native 0.30 floor (Gemini G2 verified). Production min_raw_score is
 *    pilot-derived independently of UDKB's ce_threshold.
 * Gemini G3/G4 (THIN_ADAPTER / UDKB-orchestration) REJECTED: conflicts with paid
 * SL-199 PASS + one-embed invariant (UDKB Lane-B would re-embed). Floor stays in gbrain.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  awaitPendingSearchCacheWrites,
  hybridSearch,
  hybridSearchCached,
} from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import {
  KNOBS_HASH_VERSION,
} from '../../src/core/search/mode.ts';
import type { PageInput } from '../../src/core/types.ts';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
// Optional second engine to prove the Lane-B degradation contract on the
// Postgres searchVector path too (the restrict seam lives in both engines).
let pgEngine: PostgresEngine | null = null;
let prevGbrainHome: string | undefined;
let isolatedHome: string;

const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));
const CLOSE_EMB = Float32Array.from(FAKE_EMB); // cosine ~1.0 to query → Lane-A surfaces
// Irrelevant governed embedding: raw cosine ≈ 0.40 to the query — BELOW the test
// floor (0.50, so the floor must exclude it) but ABOVE HNSW's effective reach (so
// BOTH Postgres-HNSW and PGLite-brute-force RETRIEVE it in Lane-B). SL-213 fix: the
// prior FAR_EMB (≈0.01) was below HNSW reach → Postgres never retrieved it (T15.1/T15.2
// passed for the wrong reason). At ≈0.40 both engines retrieve it → the floor, not
// recall, is what excludes it. (cosine(FAKE_EMB,[0.42,0.9,0,…]) ≈ 0.402)
const IRR_EMB = Float32Array.from({ length: DIMS }, (_, j) => (j === 0 ? 0.42 : (j === 1 ? 0.9 : 0)));
// Relevant governed embeddings: cosine ≈ 0.66 to the query — ABOVE the test
// floor (0.5) so Lane-B admits them, but BELOW the non-governed (1.0) so Lane-A's
// top-K excludes them (the lane's reason to exist). Distinct vectors ⇒ separate
// pages for the bounded one-candidate test. (cosine to FAKE_EMB ≈ 0.7·1/(1.074·0.99))
const REL_GOV_A = Float32Array.from({ length: DIMS }, (_, j) => (j === 0 ? 0.7 : (j === 1 ? 0.7 : 0)));
const REL_GOV_B = Float32Array.from({ length: DIMS }, (_, j) => (j === 0 ? 0.7 : (j === 2 ? 0.7 : 0)));

// One-embed invariant probe: count gateway embed-transport invocations so T14
// can assert Lane-B adds ZERO embed calls (it reuses the precomputed
// queryEmbedding via searchVector(embedding), which does not embed).
let embedTransportCalls = 0;
function stubEmbeddings(): void {
  __setEmbedTransportForTests(async (args: any) => {
    embedTransportCalls++;
    return { embeddings: args.values.map(() => FAKE_EMB) } as any;
  });
}

/** Seed the governed/non-governed fixture into any engine supporting the putPage/upsertChunks API. */
async function seedFixture(eng: { putPage: (s: string, p: PageInput) => Promise<unknown>; upsertChunks: (s: string, c: any[]) => Promise<unknown> }): Promise<void> {
  const evtPages: Array<[string, PageInput, string]> = [
    ['zendesk/case-a', { type: 'note', title: 'Case A', compiled_truth: 'rbl definitional bounce' }, 'rbl definitional bounce case a'],
    ['zendesk/case-b', { type: 'note', title: 'Case B', compiled_truth: 'rbl definitional bounce' }, 'rbl definitional bounce case b'],
    ['zendesk/case-c', { type: 'note', title: 'Case C', compiled_truth: 'rbl definitional bounce' }, 'rbl definitional bounce case c'],
    ['ticket/inst-a', { type: 'note', title: 'Inst A', compiled_truth: 'rbl definitional bounce' }, 'rbl definitional bounce inst a'],
    ['ticket/inst-b', { type: 'note', title: 'Inst B', compiled_truth: 'rbl definitional bounce' }, 'rbl definitional bounce inst b'],
    ['ticket/inst-c', { type: 'note', title: 'Inst C', compiled_truth: 'rbl definitional bounce' }, 'rbl definitional bounce inst c'],
  ];
  for (const [slug, page, chunkText] of evtPages) {
    await eng.putPage(slug, page);
    await eng.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: chunkText, chunk_source: 'compiled_truth', embedding: CLOSE_EMB },
    ]);
  }
  // Irrelevant governed page: raw cosine ≈ 0.40 (below floor 0.50, above HNSW
  // reach) AND text omits query keywords → Lane-A top-K excludes it; Lane-B
  // (slug-restricted) RETRIEVES it on both engines; the floor must EXCLUDE it.
  await eng.putPage('governed-corpus/email_rbl', {
    type: 'note',
    title: 'Email RBL Authority',
    compiled_truth: 'unrelated authority topic content',
  });
  await eng.upsertChunks('governed-corpus/email_rbl', [
    { chunk_index: 0, chunk_text: 'unrelated authority topic content', chunk_source: 'compiled_truth', embedding: IRR_EMB },
  ]);
  // Two RELEVANT governed pages: cosine ≈0.66 (above floor 0.5, below non-governed
  // 1.0 ⇒ Lane-A top-K excludes them). chunk_text deliberately AVOIDS the query
  // terms so Lane-A's keyword arm doesn't boost them either — the lane is what
  // surfaces them (via slug-restricted vector search + raw-cosine floor). Used by
  // the bounded-context-augmentation RED tests: relevant survival at the reserved
  // TAIL slot, and bounded one-candidate (only ONE of the two admitted).
  await eng.putPage('governed-corpus/rbl_authority', { type: 'note', title: 'RBL Authority', compiled_truth: 'authority reference document content' });
  await eng.upsertChunks('governed-corpus/rbl_authority', [{ chunk_index: 0, chunk_text: 'authority reference document content', chunk_source: 'compiled_truth', embedding: REL_GOV_A }]);
  await eng.putPage('governed-corpus/dns_authority', { type: 'note', title: 'DNS Authority', compiled_truth: 'authority reference document content' });
  await eng.upsertChunks('governed-corpus/dns_authority', [{ chunk_index: 0, chunk_text: 'authority reference document content', chunk_source: 'compiled_truth', embedding: REL_GOV_B }]);

  // TRUSTED/ pages (ARBITRARY prefix for genericization RED — proves the lane
  // prefix is caller-supplied via reservedLanePrefixes, NOT hardcoded). Same
  // cosine strategy as governed-corpus: relevant pages at ≈0.66 (above floor,
  // below non-governed 1.0), irrelevant at ≈0.40 (below floor). chunk_text
  // avoids query terms so Lane-A keyword arm doesn't boost them.
  await eng.putPage('trusted/rbl-guide', { type: 'note', title: 'Trusted RBL', compiled_truth: 'authority reference document content' });
  await eng.upsertChunks('trusted/rbl-guide', [{ chunk_index: 0, chunk_text: 'authority reference document content', chunk_source: 'compiled_truth', embedding: REL_GOV_A }]);
  await eng.putPage('trusted/dns-guide', { type: 'note', title: 'Trusted DNS', compiled_truth: 'authority reference document content' });
  await eng.upsertChunks('trusted/dns-guide', [{ chunk_index: 0, chunk_text: 'authority reference document content', chunk_source: 'compiled_truth', embedding: REL_GOV_B }]);
  await eng.putPage('trusted/irrelevant', { type: 'note', title: 'Trusted Irrelevant', compiled_truth: 'unrelated authority topic content' });
  await eng.upsertChunks('trusted/irrelevant', [{ chunk_index: 0, chunk_text: 'unrelated authority topic content', chunk_source: 'compiled_truth', embedding: IRR_EMB }]);
}

async function countCacheRows(queryText?: string): Promise<number> {
  const sql = queryText
    ? 'SELECT COUNT(*)::int AS n FROM query_cache WHERE query_text = $1'
    : 'SELECT COUNT(*)::int AS n FROM query_cache';
  const rows = queryText
    ? await engine.executeRaw<{ n: number }>(sql, [queryText])
    : await engine.executeRaw<{ n: number }>(sql);
  return rows[0].n;
}

beforeAll(async () => {
  prevGbrainHome = process.env.GBRAIN_HOME;
  isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-govlane-home-'));
  process.env.GBRAIN_HOME = isolatedHome;

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedFixture(engine);

  // Optional Postgres engine for the T14 per-engine degradation path.
  if (process.env.DATABASE_URL) {
    pgEngine = new PostgresEngine();
    await pgEngine.connect({ database_url: process.env.DATABASE_URL, engine: 'postgres' });
    await pgEngine.initSchema();
    await seedFixture(pgEngine);
  }

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  stubEmbeddings();
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (pgEngine) await pgEngine.disconnect();
  if (prevGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevGbrainHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM query_cache');
}, 30_000);

const Q = 'rbl definitional';

describe('T13 — governed-lane-ON skips query cache (Option B); default-OFF preserved, no version bump', () => {
  test('governed-lane-ON writes ZERO cache rows; default-OFF still caches; KNOBS_HASH_VERSION unchanged', async () => {
    // --- default-OFF baseline: legacy cache behavior is preserved ---
    await hybridSearchCached(engine, Q, { limit: 5, useCache: true } as any);
    await awaitPendingSearchCacheWrites();
    const offRows = await countCacheRows(Q);
    expect(offRows).toBe(1); // precondition: cache active in this hermetic env

    // --- governed-lane-ON: must skip the cache entirely (no store) ---
    await engine.executeRaw('DELETE FROM query_cache');
    await hybridSearchCached(engine, Q, { limit: 5, useCache: true, reservedLanePrefixes: ['governed-corpus/'] } as any);
    await awaitPendingSearchCacheWrites();
    const onRows = await countCacheRows(Q);
    expect(onRows).toBe(0);                     // governed-lane-ON skips cache
    expect(onRows).toBeLessThan(offRows);        // contrast: skip < default-off

    // --- no hash-version bump: Option B (cache-skip) leaves mode.ts untouched. ---
    expect(KNOBS_HASH_VERSION).toBe(15);
  });
});

/**
 * T14 — Lane-B failure degrades to exact Lane-A. Run for EACH relevant engine
 * path (PGLite always; Postgres when available) per SL-184. The forced
 * Lane-B error overrides the engine's searchVector to throw when a restrict
 * prefix set is passed — that is exactly the Lane-B call shape.
 */
async function runLaneBDegradation(getEng: () => PGLiteEngine | PostgresEngine, label: string): Promise<void> {
  test(`T14 [${label}]: happy path surfaces governed; forced Lane-B throw degrades to exact Lane-A`, async () => {
    const eng = getEng();
    // happy-path anchor: reservedLanePrefixes set ⇒ candidate surfaces via Lane-B.
    embedTransportCalls = 0;
    const happyOn = await hybridSearch(eng as any, Q, { limit: 5, reservedLanePrefixes: ['governed-corpus/'] } as any);
    const onEmbedCalls = embedTransportCalls;
    expect(
      happyOn.some(r => r.slug.startsWith('governed-corpus/')),
    ).toBe(true);

    // baseline: Lane-A only (no reservedLanePrefixes) — lane candidates excluded by the fixture.
    embedTransportCalls = 0;
    const laneAOnly = await hybridSearch(eng as any, Q, { limit: 5 } as any);
    const offEmbedCalls = embedTransportCalls;
    expect(laneAOnly.some(r => r.slug.startsWith('governed-corpus/'))).toBe(false);

    // one-embedQuery invariant (SL-184/185/190): Lane-B reuses the precomputed
    // queryEmbedding via searchVector(embedding) — it adds ZERO embed calls.
    // Spy-proven: governed-ON embed count == governed-OFF == exactly 1 (single
    // non-expanded query; bare hybridSearch does no cache-lookup embed).
    expect(offEmbedCalls).toBe(1);
    expect(onEmbedCalls).toBe(1);
    expect(onEmbedCalls).toBe(offEmbedCalls);

    // degradation: force Lane-B to throw, assert exact Lane-A recovery.
    const origSearchVector = eng.searchVector.bind(eng);
    let laneBThrowCount = 0;
    try {
      (eng as any).searchVector = (emb: Float32Array, opts?: any) => {
        if (opts?.restrict_slug_prefixes?.length) {
          laneBThrowCount++;
          throw new Error('forced Lane-B failure');
        }
        return origSearchVector(emb, opts);
      };

      let degraded: Awaited<ReturnType<typeof hybridSearch>> | undefined;
      let didThrow = false;
      try {
        degraded = await hybridSearch(eng as any, Q, { limit: 5, reservedLanePrefixes: ['governed-corpus/'] } as any);
      } catch {
        didThrow = true;
      }

      expect(laneBThrowCount).toBeGreaterThan(0); // Lane-B path was actually exercised on this engine
      expect(didThrow).toBe(false);               // (a) legacy search succeeds
      expect(degraded).toBeDefined();
      expect(degraded!.some(r => r.slug.startsWith('governed-corpus/'))).toBe(false); // (b) zero broadened governed
      expect(degraded!.map(r => r.slug).sort()).toEqual(laneAOnly.map(r => r.slug).sort()); // (c) exact Lane-A
    } finally {
      (eng as any).searchVector = origSearchVector;
    }
  }, 60_000);
}

describe('T14 — Lane-B failure degrades to exact Lane-A (per engine)', () => {
  // PGLite path — always exercised. Postgres path is registered when
  // DATABASE_URL is present at load time (test bodies run after beforeAll
  // connects pgEngine, so the engine is ready by then).
  runLaneBDegradation(() => engine, 'PGLite');
  if (process.env.DATABASE_URL) runLaneBDegradation(() => pgEngine!, 'Postgres');
});

/**
 * T15 — BOUNDED-CONTEXT AUGMENTATION (RED, SL-211). PM resolution of note c:
 * REJECT rank-0 pin; admit at most ONE deduplicated relevant governed candidate
 * into a reserved TAIL context slot when limit>=2 (replacing only the Lane-A
 * tail if full); preserve Lane-A top + relative order; limit<2 ⇒ Lane-A only.
 * Lane-B admission uses configurable min_raw_score (raw-cosine, pre-source-factor).
 *
 * RED contract: each case FAILS on the frozen old-merge code (prepend top-3, no
 * floor) solely because the bounded-merge + raw-cosine floor is unimplemented.
 * Existing controls (12-case seam, T13, T14) remain stable. Both engines.
 */
async function runBoundedMergeCases(getEng: () => PGLiteEngine | PostgresEngine, label: string): Promise<void> {
  const LIMIT = 5;
  const FLOOR = 0.5; // explicit test threshold (raw-cosine domain); NOT a production default
  const gov = (s: string) => s.startsWith('governed-corpus/');

  test(`T15.0 [${label}]: PRE-CONDITION — searchVector(restrict) retrieves email_rbl on BOTH engines (proves the floor, not recall)`, async () => {
    const eng = getEng();
    // Direct Lane-B probe with the query embedding (FAKE_EMB = what the stub returns
    // and what hybridSearch's Lane-B reuses). email_rbl cosine ≈ 0.40 ⇒ both Postgres
    // HNSW and PGLite brute-force MUST retrieve it. If this fails, the fixture cosine
    // is below an engine's reach and T15.1/T15.2 would pass for the wrong reason.
    const laneB = await (eng as any).searchVector(Float32Array.from(FAKE_EMB), { restrict_slug_prefixes: ['governed-corpus/'], limit: 5 } as any);
    expect(laneB.some((r: any) => r.slug === 'governed-corpus/email_rbl')).toBe(true);
  });

  test(`T15.1 [${label}]: irrelevant governed EXCLUDED (raw cosine < floor)`, async () => {
    const eng = getEng();
    const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['governed-corpus/'], reservedLaneMinRawScore: FLOOR } as any);
    expect(res.some(r => r.slug === 'governed-corpus/email_rbl')).toBe(false); // irrelevant (FAR_EMB, cosine≪floor) must not be admitted
  });

  test(`T15.2 [${label}]: boosted irrelevant STILL excluded (floor on raw, not re-ranked score)`, async () => {
    const eng = getEng();
    const saved = process.env.GBRAIN_SOURCE_BOOST;
    process.env.GBRAIN_SOURCE_BOOST = 'governed-corpus/:2.0'; // sourceFactor=2 ⇒ re-ranked .score inflates, but raw cosine unchanged
    try {
      const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['governed-corpus/'], reservedLaneMinRawScore: FLOOR } as any);
      expect(res.some(r => r.slug === 'governed-corpus/email_rbl')).toBe(false); // raw<floor ⇒ excluded despite boost
    } finally {
      if (saved === undefined) delete process.env.GBRAIN_SOURCE_BOOST; else process.env.GBRAIN_SOURCE_BOOST = saved;
    }
  });

  test(`T15.3 [${label}]: relevant governed survives in the reserved TAIL slot`, async () => {
    const eng = getEng();
    const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['governed-corpus/'], reservedLaneMinRawScore: FLOOR } as any);
    const admitted = res.filter(r => gov(r.slug));
    expect(admitted.length).toBe(1);                              // exactly one governed
    expect(res[res.length - 1]?.slug).toMatch(/governed-corpus\//); // ...at the TAIL (last position)
    expect(res[0]?.slug).not.toMatch(/governed-corpus\//);         // ...NOT rank-0 (reject pin)
  });

  test(`T15.4 [${label}]: Lane-A TOP + relative order preserved`, async () => {
    const eng = getEng();
    const laneA = await hybridSearch(eng as any, Q, { limit: LIMIT } as any);
    const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['governed-corpus/'], reservedLaneMinRawScore: FLOOR } as any);
    expect(res[0]?.slug).toBe(laneA[0]?.slug);                     // Lane-A top preserved (rank-0 unchanged)
    const resNg = res.filter(r => !gov(r.slug)).map(r => r.slug);  // non-governed keep relative order
    const laneANg = laneA.filter(r => !gov(r.slug)).map(r => r.slug).slice(0, LIMIT - 1);
    expect(resNg).toEqual(laneANg);
  });

  test(`T15.5 [${label}]: bounded ONE candidate + dedup (multiple relevant ⇒ still one)`, async () => {
    const eng = getEng();
    const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['governed-corpus/'], reservedLaneMinRawScore: FLOOR } as any);
    expect(res.filter(r => gov(r.slug)).length).toBe(1); // both rbl_authority + dns_authority are relevant, but only ONE admitted
  });

  test(`T15.6 [${label}]: limit<2 ⇒ Lane-A only (no governed)`, async () => {
    const eng = getEng();
    const res = await hybridSearch(eng as any, Q, { limit: 1, reservedLanePrefixes: ['governed-corpus/'], reservedLaneMinRawScore: FLOOR } as any);
    expect(res.some(r => gov(r.slug))).toBe(false); // limit<2 ⇒ reserved tail slot not created
  });
}

describe('T15 — bounded-context augmentation (RED, per engine)', () => {
  runBoundedMergeCases(() => engine, 'PGLite');
  if (process.env.DATABASE_URL) runBoundedMergeCases(() => pgEngine!, 'Postgres');
});

// ─── T16 GENERICIZATION RED (SL-222/224): caller-supplied reservedLanePrefixes ──
// These tests FAIL on the committed literal-bearing code (ecf42981) because the
// generic API (reservedLanePrefixes / GBRAIN_RESERVED_LANE_PREFIXES /
// reservedLaneMinRawScore) is NOT yet implemented — the production source
// hardcodes a literal prefix set. Expected: failures
// solely from the missing generic API/env/validation + literal-removal. Existing
// T13/T14/T15 tests remain unchanged.

test('T16.0: NO application literal governed-corpus/ in production source (src/)', () => {
  // git grep exits 1 (no matches) after GREEN removes the literal.
  // Currently exits 0 (literal at hybrid.ts:203) → FAIL (RED).
  let exitCode = 0;
  try {
    execSync('git grep --count governed-corpus/ -- src/', { stdio: 'pipe' });
  } catch (e: any) {
    exitCode = e.status ?? 1;
  }
  expect(exitCode).toBe(1);
});

async function runGenericLaneCases(getEng: () => PGLiteEngine | PostgresEngine, label: string): Promise<void> {
  const LIMIT = 5;
  const trusted = (s: string) => s.startsWith('trusted/');

  test(`T16.1 [${label}]: arbitrary prefix trusted/ works via reservedLanePrefixes`, async () => {
    const eng = getEng();
    const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['trusted/'] } as any);
    expect(res.some(r => trusted(r.slug))).toBe(true);
  });

  test(`T16.2 [${label}]: two prefixes deterministic (trusted/ + docs/ → one candidate)`, async () => {
    const eng = getEng();
    const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['trusted/', 'docs/'] } as any);
    const laneCands = res.filter(r => trusted(r.slug) || r.slug.startsWith('docs/'));
    expect(laneCands.length).toBe(1); // bounded one
  });

  test(`T16.3 [${label}]: env GBRAIN_RESERVED_LANE_PREFIXES=trusted/ activates lane`, async () => {
    const eng = getEng();
    const saved = process.env.GBRAIN_RESERVED_LANE_PREFIXES;
    process.env.GBRAIN_RESERVED_LANE_PREFIXES = 'trusted/';
    try {
      const res = await hybridSearch(eng as any, Q, { limit: LIMIT } as any);
      expect(res.some(r => trusted(r.slug))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GBRAIN_RESERVED_LANE_PREFIXES;
      else process.env.GBRAIN_RESERVED_LANE_PREFIXES = saved;
    }
  });

  test(`T16.4 [${label}]: whitespace + duplicate normalization ([' trusted/ ', 'trusted/'] → one)`, async () => {
    const eng = getEng();
    const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: [' trusted/ ', 'trusted/'] } as any);
    expect(res.some(r => trusted(r.slug))).toBe(true);
  });

  test(`T16.5 [${label}]: configurable reservedLaneMinRawScore (0.9 blocks, 0.5 admits)`, async () => {
    const eng = getEng();
    // relevant trusted/ cosine ≈ 0.66; floor 0.9 > 0.66 → no candidate
    const blocked = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['trusted/'], reservedLaneMinRawScore: 0.9 } as any);
    expect(blocked.some(r => trusted(r.slug))).toBe(false);
    // floor 0.5 < 0.66 → candidate admitted
    const admitted = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['trusted/'], reservedLaneMinRawScore: 0.5 } as any);
    expect(admitted.some(r => trusted(r.slug))).toBe(true);
  });

  test(`T16.6 [${label}]: empty/unset reservedLanePrefixes → exact legacy (no lane, no candidate)`, async () => {
    const eng = getEng();
    const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: [] } as any);
    expect(res.some(r => trusted(r.slug))).toBe(false);
    expect(res.some(r => r.slug.startsWith('governed-corpus/'))).toBe(false);
  });

  test(`T16.7 [${label}]: invalid prefix (path traversal /../) → fail closed`, async () => {
    const eng = getEng();
    const res = await hybridSearch(eng as any, Q, { limit: LIMIT, reservedLanePrefixes: ['./../'] } as any);
    expect(res.some(r => trusted(r.slug))).toBe(false);
  });
}

describe('T16 — genericization: caller-supplied reservedLanePrefixes (RED, per engine)', () => {
  runGenericLaneCases(() => engine, 'PGLite');
  if (process.env.DATABASE_URL) runGenericLaneCases(() => pgEngine!, 'Postgres');
});
