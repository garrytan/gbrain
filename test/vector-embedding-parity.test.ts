/**
 * Vector and embedding parity: searchVector, the hybrid fusion that reads it,
 * and the embedding-state methods (getEmbeddingsByChunkIds, countStaleChunks,
 * sumStaleChunkChars, setPageEmbeddingSignature,
 * invalidateStaleSignatureEmbeddings, invalidateContentDriftEmbeddings,
 * listStaleChunks, readEmbeddingStateCounts, listEmbeddingStateRows and
 * getChunksWithEmbeddings) return and refuse the same things on PGLite and
 * Postgres (in-memory PGLite; Postgres too when DATABASE_URL is set).
 *
 * Rust engine contract (an exact flat scan). Two kinds of output:
 * - QUALITY-GATED: the cosine score. PGLite (pgvector in WASM) and Postgres
 *   (native pgvector) round differently in the last float bits: a self match
 *   is 1 on one and 0.99999984 on the other. A score is checked against the
 *   float64 cosine of the stored float32 vectors within SCORE_TOLERANCE, and
 *   compared across engines rounded to 4 places. Rust must stay inside the
 *   tolerance; it need not match either engine bit for bit. Rows whose scores
 *   differ by less than the tolerance may change places, so no case here puts
 *   two different vectors that close together.
 * - ESTIMATE: readEmbeddingStateCounts in 'ops' mode reads counts.embedded
 *   from the planner's row estimate (basis 'estimated'). Rust must return a
 *   non-negative integer there; the number is not compared.
 * - EXACT: everything else, and Rust must give it: which rows come back, the
 *   order of rows whose scores differ by more than the tolerance, the tie
 *   order (equal vectors: page_id, then chunk_id), one row per page (its best
 *   chunk), the result keys, limit and offset handling, every filter, the
 *   model and text-hash guard, the refusal code and message for a bad query
 *   vector, the NaN score of a zero query vector, and every embedding-state
 *   count, row and order. Stored vectors read back bit for bit as float32.
 *   The hybridSearch slug order is exact too: fusion runs in TypeScript on
 *   the engine's vector and keyword rows, so a Rust engine that matches the
 *   rows above gives the same fused order.
 * One difference by design: a query vector of the wrong width is refused by
 * pgvector's HNSW index scan, and the message depends on the pgvector build.
 * Before 0.8.7 the scan's distance call says "different vector dimensions
 * <query> and <stored>"; from 0.8.7 the scan checks the width first and says
 * "expected <stored> dimensions, not <query>" (both SQLSTATE 22000). PGLite
 * bundles pgvector 0.8.1; the pgvector/pgvector:pg16 image ships 0.8.7, so the
 * Postgres arm reads the installed version and expects that build's message.
 * Past that and the score rounding, both engines give one answer for every
 * case below. Shapes Rust must keep: a
 * listStaleChunks row carries updated_at (a Date) only in the 'updated_desc'
 * order; readEmbeddingStateCounts names covering_index
 * 'content_chunks_stale_idx' in 'ops' mode and null in 'full' mode.
 *
 * 1. Protects: searchVector order, ties, best-per-page, limit and offset,
 *    filters (type, types, source, archived source, soft delete, quarantine,
 *    private, pinned question, slug lists and prefixes, detail low), the model
 *    and text-hash guard, bad query vectors, hybrid fusion order, and the
 *    embedding-state methods named above.
 * 2. Fails when: an engine returns other rows, another order or tie order,
 *    more than one row per page, a score outside the tolerance, refuses an
 *    input with another code or message, or counts, lists or invalidates
 *    embeddings differently.
 * 3. Existing coverage: test/search-types-filter, test/vector-ef-search,
 *    test/legacy-vector-compatibility, test/search-image-column,
 *    test/embedding-recovery.serial, test/embedding-zero-norm-4616.serial,
 *    test/search-during-upgrade-rebuild-9192, test/vector-manifest-probe-bound
 *    and test/pglite-engine cover single features, mostly on one engine. No
 *    file compares vector edge inputs, refusals or embedding-state output
 *    across the two engines.
 * 4. Real seams: the engines' public methods and hybridSearch. The query
 *    embedder is the gateway's test transport (no network). Soft deletes,
 *    archived sources, models, hashes and NULL vectors are set with SQL so
 *    each case is pinned.
 *
 * Out of scope: take vectors (searchTakesVector, getTakeEmbeddings,
 * updateTakeEmbeddings) belong to the takes group; the 100-row limit cap
 * needs a larger corpus (test/vector-ef-search covers it).
 *
 * Rust arm (GBRAIN_TEST_RUST_ARM=1, test/engine-parity/rust-arm.ts): the same
 * fixture through engine methods (the Rust engine has no SQL), and the same
 * expected rows. One difference, asserted below: a refusal carries the
 * store's `invalid_argument` code with PGLite's message. Every member a hybrid
 * search calls serves `excludePrivate` as PGLite does. Cases that set state with SQL (the
 * guard's model and hash edits, embedding reads, stale chunks, state counts)
 * do not run on Rust; the store's unit tests cover the guard's model and hash
 * rules. A brain whose config routes vectors to another column refuses on Rust,
 * as the Rust embedding members do. hybridSearch runs its real pipeline on the Rust brain, and its cosine
 * rescoring reads cosinesByChunkIds, which the store serves as an exact scan.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { _resetSupersedeProbeForTests, hybridSearch, runPostFusionStages, stampContentFlags, stampUnverifiedExtractions } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';
import { applyGeneratedDemotion } from '../src/core/search/provenance-demotion.ts';
import { testBackends, type TestBackend } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { prngUnitVector, embeddingDims } from './helpers/ef-search-fixture.ts';
import { createRustSource, openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';
import type { RustEngine } from '../src/core/rust-engine.ts';

/** One case result per engine, compared at the end of the file. */
const seen = new Map<TestBackend | 'rust', Record<string, unknown>>();
const backends = testBackends();
const arms: Array<TestBackend | 'rust'> = [...backends, ...(rustArmRequested() ? ['rust' as const] : [])];
/** The Rust engine's embedding column width: the schema's `vector(1536)` (it has no catalog to read). */
const RUST_DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
/** Largest score difference allowed from the float64 cosine of the stored float32 vectors. */
const SCORE_TOLERANCE = 1e-6;

/** The expected rows of the ranking-stages case, as PGLite ranks them: `slug score flags`, the score to 4 places. */
const HYBRID_PLAIN = [
  'a-exact 1.0000',
  'd-multi 0.9885',
  'n-timeline 0.9461',
  'z-gen 0.9255 provenance="generated"',
  'z-after 0.9151',
  't-auto 0.9047 status="unverified" unverified=true',
  'u-dated 0.8946',
  't-flagged 0.8848 content_flag={"reason":"spam","detail":"x"}',
  'r-target 0.8477 collapsed=[{"slug":"r-stub","source_id":"default","reason":"redirect"}] status="verified"',
  's-new 0.8654',
  'zorbit 0.8393',
  'e-person 0.5536',
];
/**
 * A query that names the zorbit entity, run under hybrid's default scope (excludePrivate resolves to true): the entity
 * page is found through its alias, so the generated page that links to it is demoted and the entity page is boosted.
 */
const HYBRID_NAMED = [
  'zorbit 1.3600 backlink_count=1',
  'a-exact 0.5471',
  'd-multi 0.5430',
  'z-after 0.5150 alias_resolved_boost=1.05',
  'n-timeline 0.5078',
  't-auto 0.4866 status="unverified" unverified=true',
  'u-dated 0.4828',
  't-flagged 0.4792 content_flag={"reason":"spam","detail":"x"}',
  'r-target 0.4649 collapsed=[{"slug":"r-stub","source_id":"default","reason":"redirect"}] status="verified"',
  's-new 0.4715',
  'z-gen 0.2471 provenance="generated" generated_demotion=0.5',
  'e-person 0.1913',
];
/**
 * The same query as HYBRID_NAMED_PRIVATE with salience, recency and graph signals on: the effective-date, salience, backlink,
 * adjacency and supersede reads all take the page policy, and the rows PGLite answers are the rows the Rust brain answers
 * (u-dated's score depends on the day, so it is matched by shape and left out here).
 */
const HYBRID_NAMED_PRIVATE_ALL_STAGES = [
  'zorbit 1.7680 backlink_count=1 recency_boost=1.3',
  'a-exact 0.7112 recency_boost=1.3',
  'd-multi 0.7059 recency_boost=1.3',
  'z-after 0.6695 alias_resolved_boost=1.05 recency_boost=1.3',
  'n-timeline 0.6601 recency_boost=1.3',
  't-auto 0.6325 recency_boost=1.3 status="unverified" unverified=true',
  't-flagged 0.6229 recency_boost=1.3 content_flag={"reason":"spam","detail":"x"}',
  'r-target 0.6044 collapsed=[{"slug":"r-stub","source_id":"default","reason":"redirect"}] recency_boost=1.3 status="verified"',
  's-new 0.6130 recency_boost=1.3',
  'e-person 0.2521 recency_boost=1.3',
];

/** The same query with excludePrivate: true: PGLite hides the generated page and the rest of the order holds (11 rows). */
const HYBRID_NAMED_PRIVATE = [
  'zorbit 1.3600 backlink_count=1',
  'a-exact 0.5471',
  'd-multi 0.5430',
  'z-after 0.5150 alias_resolved_boost=1.05',
  'n-timeline 0.5078',
  't-auto 0.4866 status=\"unverified\" unverified=true',
  'u-dated 0.4828',
  't-flagged 0.4792 content_flag={\"reason\":\"spam\",\"detail\":\"x\"}',
  'r-target 0.4649 collapsed=[{\"slug\":\"r-stub\",\"source_id\":\"default\",\"reason\":\"redirect\"}] status=\"verified\"',
  's-new 0.4715',
  'e-person 0.1939',
];
const STAGES_WITHOUT_DATED = [
  'a-exact 1.3000 recency_boost=1.3',
  'd-multi 1.3000 recency_boost=1.3',
  'n-timeline 1.1644 recency_boost=1.3',
  'z-gen 1.1218 recency_boost=1.3',
  'z-after 1.1777 alias_resolved_boost=1.05 recency_boost=1.3',
  't-auto 1.1202 recency_boost=1.3',
  't-flagged 1.1177 recency_boost=1.3',
  'r-stub 1.1138 recency_boost=1.3',
  's-new 1.1123 recency_boost=1.3',
  's-old 0.5749 superseded_by="s-new" backlink_count=1 recency_boost=1.3',
  'r-target 1.1098 recency_boost=1.3',
  'zorbit 1.1476 backlink_count=1 recency_boost=1.3',
  'f-srcb 0.0317 recency_boost=1.3',
  'i-private 0.0315 recency_boost=1.3',
  'e-person -0.0277 recency_boost=1.3',
  'b-tie1 -0.0542 recency_boost=1.3',
  'c-tie2 -0.0542 recency_boost=1.3',
  'k-opposite -1.3000 recency_boost=1.3',
];
const MARKERS = [
  't-auto 0.8617 status="unverified" unverified=true',
  't-flagged 0.8597 content_flag={"reason":"spam","detail":"x"}',
  'r-target 0.8537 status="verified"',
];
const DEMOTION = [
  'z-gen 0.4315 provenance="generated" generated_demotion=0.5',
];

function record(kind: TestBackend | 'rust', name: string, value: unknown): void {
  const run = seen.get(kind) ?? {};
  run[name] = value;
  seen.set(kind, run);
}

/** 'done' for a call that returns nothing, the value otherwise, or the refusal code and message. */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await fn();
    return value === undefined ? 'done' : { ok: value };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { refused: err.code ?? 'no code', message: String(err.message) };
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / Math.sqrt(na * nb);
}

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

for (const kind of arms) {
  describe(`vectors and embeddings (${kind})`, () => {
    const rust = kind === 'rust';
    /** The refusal code of a bad input: PGLite's SQLSTATE, or the Rust store's code (same message). */
    const badInput = (sqlstate: string) => (rust ? 'invalid_argument' : sqlstate);
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let dims = 0;
    let q: Float32Array = new Float32Array(0);
    /** The installed pgvector version on the SQL arms (PGLite bundles its own); unset on Rust. */
    let pgvector: string | undefined;
    /**
     * The refusal message for a query of `query` dimensions against `stored`-dimension vectors, read through the HNSW
     * index (the default searchVector plan). pgvector 0.8.7 added a width check to the HNSW scan, so its message differs
     * from every earlier build's; the Rust store gives the earlier wording, which PGLite's bundled 0.8.1 gives.
     */
    const wrongWidthMessage = (query: number, stored: number) => {
      const m = pgvector?.match(/^(\d+)\.(\d+)\.(\d+)/);
      const checksWidth = !!m && (Number(m[1]) > 0 || Number(m[2]) > 8 || (Number(m[2]) === 8 && Number(m[3]) >= 7));
      return checksWidth ? `expected ${stored} dimensions, not ${query}` : `different vector dimensions ${query} and ${stored}`;
    };
    const raw = (sql: string) => engine.executeRaw<Record<string, unknown>>(sql);
    /** Every stored vector by `slug#chunk_index`, for the expected scores. */
    const stored = new Map<string, Float32Array>();
    const v = (i: number) => prngUnitVector(i, dims);
    const page = async (slug: string, vecs: Array<Float32Array | null>, o: { type?: string; sourceId?: string; fm?: Record<string, unknown>; timeline?: boolean; effectiveDate?: string } = {}) => {
      const scope = o.sourceId ? { sourceId: o.sourceId } : undefined;
      await engine.putPage(slug, { type: o.type ?? 'note', title: slug, compiled_truth: `body ${slug}`, timeline: o.timeline ? `timeline ${slug}` : '', frontmatter: o.fm ?? {}, ...(o.effectiveDate ? { effective_date: o.effectiveDate } : {}) } as never, scope as never);
      const chunks = vecs.map((e, i) => ({
        chunk_index: i, chunk_text: o.timeline && i === 0 ? `timeline ${slug}` : `body ${slug} ${i}`,
        chunk_source: o.timeline && i === 0 ? 'timeline' : 'compiled_truth', ...(e ? { embedding: e, model: MODEL } : {}),
      }));
      if (rust) await engine.sealChunks(slug, chunks as never, scope);
      else await installFixtureChunks(engine, slug, chunks as never, scope);
      vecs.forEach((e, i) => { if (e) stored.set(`${slug}#${i}`, e); });
    };
    /** Rows as `slug#chunk score source`; the score rounded to 4 places (NaN kept). Checks each score against the expected cosine. */
    const rows = (list: Array<Record<string, unknown>>, query: Float32Array) => list.map((r) => {
      const name = `${r.slug}#${r.chunk_index}`;
      const score = Number(r.score);
      const want = stored.has(name) ? cosine(stored.get(name)!, query) : Number.NaN;
      if (Number.isNaN(want)) expect(score).toBeNaN();
      else expect(Math.abs(score - want)).toBeLessThan(SCORE_TOLERANCE);
      return `${name} ${Number.isNaN(score) ? 'NaN' : score.toFixed(4)} ${r.source_id}`;
    });
    const sv = (query: Float32Array, opts?: unknown) =>
      outcome(async () => rows((await engine.searchVector(query, opts as never)) as never, query));
    const ok = (x: unknown) => (x as { ok: unknown }).ok;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1));
      else if (rust) {
        const brain = await openRustBrain();
        engine = brain.engine as unknown as BrainEngine;
        close = async () => { await engine.disconnect(); removeBrainDir(brain.dir); };
      } else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      dims = rust ? RUST_DIMS : await embeddingDims(engine);
      if (!rust) pgvector = String((await raw(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`))[0]?.extversion);
      q = v(0);
      if (rust) {
        await createRustSource(engine, 'src-b', {});
        await createRustSource(engine, 'src-arch', {});
        await fixture();
        return;
      }
      await raw(`INSERT INTO sources (id, name) VALUES ('src-b', 'src-b'), ('src-arch', 'src-arch') ON CONFLICT DO NOTHING`);
      await fixture();
      await raw(`UPDATE pages SET deleted_at = now() WHERE slug = 'g-deleted'`);
      await raw(`UPDATE sources SET archived = true WHERE id = 'src-arch'`);
    }, 120_000);

    /** The pages every case reads. The soft delete and the archived source are set after (SQL, or the Rust store). */
    const fixture = async () => {
      await page('a-exact', [q]);
      await page('b-tie1', [v(1)]);
      await page('c-tie2', [v(1)]);
      await page('d-multi', [v(2), q, v(3)]);
      await page('e-person', [v(4)], { type: 'person' });
      await page('f-srcb', [v(5)], { sourceId: 'src-b' });
      await page('g-deleted', [v(6)]);
      await page('h-quarantined', [v(7)], { fm: { quarantine: true } });
      await page('i-private', [v(8)], { fm: { visibility: 'private' } });
      await page('j-archived', [v(9)], { sourceId: 'src-arch' });
      await page('k-opposite', [q.map((x) => -x)]);
      await page('l-no-chunks', []);
      await page('m-pinned', [v(10)], { fm: { pinned_question: true } });
      await page('n-timeline', [q.map((x, i) => (i === 0 ? x + 0.5 : x)), v(11)], { timeline: true });
      await page('o-skip', [null], { fm: { embed_skip: 'test' } });
      if (rust) {
        await engine.softDeletePage('g-deleted');
        await (engine as unknown as RustEngine).openStore('setSourceArchived').brain.setSourceArchived('src-arch', true);
      }
    };

    afterAll(async () => { await close?.(); }, 60_000);

    const ALL = [
      'a-exact#0 1.0000 default', 'd-multi#1 1.0000 default', 'n-timeline#0 0.8957 default', 'f-srcb#0 0.0244 src-b',
      'i-private#0 0.0242 default', 'e-person#0 -0.0213 default', 'b-tie1#0 -0.0417 default', 'c-tie2#0 -0.0417 default',
      'k-opposite#0 -1.0000 default',
    ];

    test('searchVector: order, ties, best chunk per page, result keys', async () => {
      const basic = await sv(q);
      expect(ok(basic)).toEqual(ALL);
      const keys = Object.keys((await engine.searchVector(q, { limit: 1 }))[0] ?? {}).sort();
      expect(keys).toEqual(['chunk_id', 'chunk_index', 'chunk_source', 'chunk_text', 'effective_date', 'effective_date_source',
        'page_id', 'score', 'slug', 'source_id', 'stale', 'title', 'type']);
      const unnormalized = await sv(q.map((x) => x * 3));
      expect(ok(unnormalized)).toEqual(ALL);
      record(kind, 'order', { basic, keys, unnormalized });
    });

    test('searchVector: limit and offset', async () => {
      const cases = {
        limit1: await sv(q, { limit: 1 }),
        limit0: await sv(q, { limit: 0 }),
        limitNegative: await sv(q, { limit: -3 }),
        limitNaN: await sv(q, { limit: Number.NaN }),
        limitInfinity: await sv(q, { limit: Number.POSITIVE_INFINITY }),
        limitFractional: await sv(q, { limit: 2.7 }),
        offset2: await sv(q, { offset: 2 }),
        offset2Limit2: await sv(q, { offset: 2, limit: 2 }),
        offsetPastEnd: await sv(q, { offset: 1000 }),
        offsetNaN: await sv(q, { offset: Number.NaN }),
        offsetNegative: await sv(q, { offset: -1 }),
        offsetFractional: await sv(q, { offset: 1.5 }),
      };
      expect(cases.limit1).toEqual({ ok: ALL.slice(0, 1) });
      for (const c of [cases.limit0, cases.limitNegative, cases.limitNaN, cases.limitInfinity, cases.offsetNaN]) expect(c).toEqual({ ok: ALL });
      expect(cases.limitFractional).toEqual({ ok: ALL.slice(0, 2) });
      expect(cases.offset2).toEqual({ ok: ALL.slice(2) });
      expect(cases.offset2Limit2).toEqual({ ok: ALL.slice(2, 4) });
      expect(cases.offsetPastEnd).toEqual({ ok: [] });
      expect(cases.offsetNegative).toEqual({ refused: badInput('2201X'), message: 'OFFSET must not be negative' });
      expect(cases.offsetFractional).toEqual({ refused: badInput('22P02'), message: 'invalid input syntax for type integer: "101.5"' });
      record(kind, 'limits', cases);
    });

    test('searchVector: filters', async () => {
      const without = (...names: string[]) => ALL.filter((r) => !names.some((n) => r.startsWith(n)));
      const cases = {
        typePerson: await sv(q, { type: 'person' }),
        typesNote: await sv(q, { types: ['note'] }),
        typesEmpty: await sv(q, { types: [] }),
        sourceB: await sv(q, { sourceId: 'src-b' }),
        sourceIds: await sv(q, { sourceIds: ['src-b', 'default'] }),
        sourceIdsWin: await sv(q, { sourceIds: ['src-b'], sourceId: 'default' }),
        sourceIdsEmpty: await sv(q, { sourceIds: [], sourceId: 'src-b' }),
        archivedSource: await sv(q, { sourceId: 'src-arch' }),
        unknownSource: await sv(q, { sourceId: 'nope' }),
        excludeSlugs: await sv(q, { exclude_slugs: ['a-exact'] }),
        excludePrefixes: await sv(q, { exclude_slug_prefixes: ['b-', 'c-'] }),
        includePrefixes: await sv(q, { include_slug_prefixes: ['d-'] }),
        excludePrivate: await sv(q, { excludePrivate: true }),
        excludePrivateOff: await sv(q, { excludePrivate: false }),
        excludePrivateScoped: await sv(q, { excludePrivate: true, sourceId: 'default' }),
        excludePrivateOnePage: await sv(q, { excludePrivate: true, limit: 1 }),
        excludePrivateWithType: await sv(q, { excludePrivate: true, type: 'nonesuch' }),
        detailLow: await sv(q, { detail: 'low' }),
      };
      expect(cases.typePerson).toEqual({ ok: ['e-person#0 -0.0213 default'] });
      expect(cases.typesNote).toEqual({ ok: without('e-person') });
      expect(cases.typesEmpty).toEqual({ ok: ALL });
      expect(cases.sourceB).toEqual({ ok: ['f-srcb#0 0.0244 src-b'] });
      expect(cases.sourceIds).toEqual({ ok: ALL });
      expect(cases.sourceIdsWin).toEqual({ ok: ['f-srcb#0 0.0244 src-b'] });
      expect(cases.sourceIdsEmpty).toEqual({ ok: ['f-srcb#0 0.0244 src-b'] });
      expect(cases.archivedSource).toEqual({ ok: [] });
      expect(cases.unknownSource).toEqual({ ok: [] });
      expect(cases.excludeSlugs).toEqual({ ok: without('a-exact') });
      expect(cases.excludePrefixes).toEqual({ ok: without('b-', 'c-') });
      // include_slug_prefixes only lifts a default hard exclude; it is not an allow list.
      expect(cases.includePrefixes).toEqual({ ok: ALL });
      expect(cases.excludePrivate).toEqual({ ok: without('i-private') });
      expect(cases.excludePrivateOff).toEqual({ ok: ALL });
      expect(cases.excludePrivateScoped).toEqual({ ok: without('i-private', 'f-srcb') });
      expect(cases.excludePrivateOnePage).toEqual({ ok: without('i-private').slice(0, 1) });
      expect(cases.excludePrivateWithType).toEqual({ ok: [] });
      // detail low reads compiled_truth chunks only, so the page falls back to its next best chunk.
      expect(cases.detailLow).toEqual({ ok: [...ALL.slice(0, 2), 'f-srcb#0 0.0244 src-b', 'i-private#0 0.0242 default', 'n-timeline#1 -0.0170 default', ...ALL.slice(5)] });
      // The trust floor and the flagged-page filter apply on every engine. Every fixture page is stamped `unknown` and none
      // carries a gate flag, so a floor at `unknown` keeps every page, a floor above it keeps none (the floor is applied, not
      // ignored), and suppressFlagged hides nothing. vector-options.test.ts covers mixed tiers and flagged pages.
      const trust = {
        floorUnknown: await sv(q, { minTrust: 'unknown' }),
        floorAgent: await sv(q, { minTrust: 'agent_written' }),
        floorAgentPrivate: await sv(q, { excludePrivate: true, minTrust: 'agent_written' }),
        suppressFlaggedPrivate: await sv(q, { excludePrivate: true, suppressFlagged: true }),
      };
      expect(trust).toEqual({ floorUnknown: { ok: ALL }, floorAgent: { ok: [] }, floorAgentPrivate: { ok: [] },
        suppressFlaggedPrivate: { ok: without('i-private') } });
      if (rust) {
        // An option the store does not know still refuses beside excludePrivate, and a floor that names no tier refuses as a
        // bad argument: neither answers without the filter.
        expect(await sv(q, { excludePrivate: true, notAnOption: true })).toMatchObject({ refused: 'engine_capability_missing' });
        for (const floor of [0.5, 'trusted']) {
          expect(await sv(q, { excludePrivate: true, minTrust: floor })).toEqual({ refused: 'invalid_argument', message: `minTrust: "${floor}" names no trust tier` });
        }
      }
      record(kind, 'filtersTrust', trust);
      record(kind, 'filters', cases);
    });

    test('searchVector: bad query vectors', async () => {
      const set0 = (x: number) => { const e = new Float32Array(q); e[0] = x; return e; };
      const cases = {
        zero: await sv(new Float32Array(dims)),
        allNaN: await sv(new Float32Array(dims).fill(Number.NaN)),
        oneNaN: await sv(set0(Number.NaN)),
        infinity: await sv(set0(Number.POSITIVE_INFINITY)),
        wrongDimension: await sv(new Float32Array(8).fill(0.1)),
        empty: await sv(new Float32Array(0)),
      };
      // A zero query has no direction: every visible page's first embedded chunk, NaN score, in page order.
      expect(cases.zero).toEqual({ ok: ['a-exact#0 NaN default', 'b-tie1#0 NaN default', 'c-tie2#0 NaN default', 'd-multi#0 NaN default',
        'e-person#0 NaN default', 'f-srcb#0 NaN src-b', 'i-private#0 NaN default', 'k-opposite#0 NaN default', 'n-timeline#0 NaN default'] });
      expect(cases.allNaN).toEqual({ refused: badInput('22000'), message: 'NaN not allowed in vector' });
      expect(cases.oneNaN).toEqual({ refused: badInput('22000'), message: 'NaN not allowed in vector' });
      expect(cases.infinity).toEqual({ refused: badInput('22000'), message: 'infinite value not allowed in vector' });
      expect(cases.wrongDimension).toEqual({ refused: badInput('22000'), message: wrongWidthMessage(8, dims) });
      expect(cases.empty).toEqual({ refused: badInput('22000'), message: 'vector must have at least 1 dimension' });
      // The wrong-width wording follows each engine's pgvector build (checked exactly above), so the cross-engine
      // comparison takes its code and the fact that it is that build's width refusal, not the build's words.
      record(kind, 'badVectors', { ...cases, wrongDimension: { refused: (cases.wrongDimension as { refused: string }).refused, message: 'pgvector width refusal for this build' } });
    });

    test('searchVector: model and text-hash guard', async () => {
      const col = (model: string) => ({ embeddingColumn: { name: 'embedding', type: 'vector', dimensions: dims, embeddingModel: model } });
      const cases: Record<string, unknown> = {
        configuredModel: await sv(q, col(MODEL)),
        otherModel: await sv(q, col('other:model')),
      };
      if (rust) {
        // The rest edits a chunk's model and text hash with SQL; the Rust engine has none (the store's unit tests
        // cover those rules). The store keeps one vector column, so a config naming another refuses.
        expect(cases.configuredModel).toEqual({ ok: ALL });
        expect(cases.otherModel).toEqual({ ok: [] });
        await engine.setConfig('search_embedding_column', 'embedding_image');
        const routed = await sv(q);
        await engine.unsetConfig('search_embedding_column');
        expect((routed as { refused: string }).refused).toBe('engine_capability_missing');
        expect(await sv(q)).toEqual({ ok: ALL });
        return;
      }
      await raw(`UPDATE content_chunks SET model = 'other:model' WHERE page_id = (SELECT id FROM pages WHERE slug = 'a-exact')`);
      cases.otherModelAfter = await sv(q, col('other:model'));
      await raw(`UPDATE content_chunks SET embedded_text_hash = md5('other text') WHERE page_id = (SELECT id FROM pages WHERE slug = 'a-exact')`);
      cases.driftedHash = await sv(q, col('other:model'));
      cases.driftedHashNoModel = await sv(q);
      await raw(`UPDATE content_chunks SET embedded_text_hash = NULL WHERE page_id = (SELECT id FROM pages WHERE slug = 'a-exact')`);
      cases.nullHash = await sv(q, col('other:model'));
      await raw(`UPDATE content_chunks SET model = '${MODEL}', embedded_text_hash = md5(chunk_text) WHERE page_id = (SELECT id FROM pages WHERE slug = 'a-exact')`);
      expect(cases.configuredModel).toEqual({ ok: ALL });
      expect(cases.otherModel).toEqual({ ok: [] });
      expect(cases.otherModelAfter).toEqual({ ok: ALL.slice(0, 1) });
      expect(cases.driftedHash).toEqual({ ok: [] });
      expect(cases.driftedHashNoModel).toEqual({ ok: ALL });
      expect(cases.nullHash).toEqual({ ok: ALL.slice(0, 1) });
      record(kind, 'guard', cases);
    });

    test('cosinesByChunkIds: the text-space cosine of every served chunk with a vector', async () => {
      const sources: Record<string, string> = { 'f-srcb': 'src-b', 'j-archived': 'src-arch' };
      const idOf = new Map<string, number>();
      for (const slug of ['a-exact', 'b-tie1', 'c-tie2', 'd-multi', 'e-person', 'f-srcb', 'g-deleted', 'h-quarantined', 'i-private', 'j-archived',
        'k-opposite', 'l-no-chunks', 'm-pinned', 'n-timeline', 'o-skip']) {
        for (const c of await engine.getChunks(slug, { sourceId: sources[slug] ?? 'default', includeUnsealed: true } as never)) idOf.set(`${slug}#${c.chunk_index}`, Number(c.id));
      }
      const nameOf = new Map([...idOf].map(([name, id]) => [id, name]));
      const MISSING = 987_654_321;
      const read = async (ids: number[], query: Float32Array) => {
        const found = await engine.cosinesByChunkIds(ids, 'embedding', query);
        return new Map([...found].map(([id, cos]) => [nameOf.get(id) ?? `unknown:${id}`, cos]));
      };
      /** `name=cosine` rows, sorted, the cosine rounded to 4 places: what the engines are compared on. */
      const rowsOf = (found: Map<string, number>) => [...found].map(([name, cos]) => `${name}=${cos.toFixed(4)}`).sort();
      /** Each cosine within SCORE_TOLERANCE of the cosine of the stored vector and the query, and exactly these chunks. */
      const expectCosines = (found: Map<string, number>, names: string[], query: Float32Array) => {
        expect([...found.keys()].sort()).toEqual([...names].sort());
        for (const name of names) expect(Math.abs(found.get(name)! - cosine(stored.get(name)!, query))).toBeLessThan(SCORE_TOLERANCE);
      };
      const everything = [...idOf.values(), MISSING];
      const all = await read(everything, q);
      // Every served chunk with a vector comes back (the soft-deleted page's and the unembedded chunk's do not); a page
      // with no chunks and an id that is no chunk give no row.
      const served = [...all.keys()];
      for (const keep of ['a-exact#0', 'd-multi#0', 'd-multi#1', 'd-multi#2', 'n-timeline#0', 'n-timeline#1', 'k-opposite#0', 'e-person#0', 'f-srcb#0',
        'b-tie1#0', 'c-tie2#0', 'i-private#0']) {
        expect(served).toContain(keep);
      }
      for (const gone of ['g-deleted#0', 'o-skip#0']) expect(served).not.toContain(gone);
      expect(served.some((n) => n.startsWith('l-no-chunks') || n.startsWith('unknown:'))).toBe(false);
      expectCosines(all, served, q);
      expect(all.get('a-exact#0')).toBeCloseTo(1, 6);
      expect(all.get('k-opposite#0')).toBeCloseTo(-1, 6);
      expect(all.get('n-timeline#0')).toBeCloseTo(0.8957, 4);
      const subset = await read([idOf.get('d-multi#1')!, idOf.get('b-tie1#0')!, MISSING], q);
      expectCosines(subset, ['b-tie1#0', 'd-multi#1'], q);
      const scaled = await read(everything, q.map((x) => x * 3) as Float32Array);
      expectCosines(scaled, served, q);
      const otherQuery = await read(everything, v(1));
      expectCosines(otherQuery, served, v(1));
      expect((await read([], q)).size).toBe(0);
      expect((await read([MISSING], q)).size).toBe(0);
      // Another dimension scores 0 for every served chunk, as does a zero query.
      const shortQuery = await read(everything, new Float32Array([1, 2, 3]));
      const zeroQuery = await read(everything, new Float32Array(dims));
      for (const found of [shortQuery, zeroQuery]) expect(rowsOf(found)).toEqual(served.map((n) => `${n}=0.0000`).sort());
      // A column name the schema would not accept is refused as PGLite refuses it; the Rust store keeps only `embedding`.
      const badColumn = await outcome(() => engine.cosinesByChunkIds([idOf.get('a-exact#0')!], 'embedding; drop', q));
      expect(badColumn).toMatchObject({ refused: 'embedding_column_not_registered' });
      if (rust) {
        const otherColumn = await outcome(() => engine.cosinesByChunkIds([idOf.get('a-exact#0')!], 'embedding_image', q));
        expect(otherColumn).toMatchObject({ refused: 'engine_capability_missing' });
      }
      record(kind, 'cosines', {
        all: rowsOf(all), subset: rowsOf(subset), scaled: rowsOf(scaled), otherQuery: rowsOf(otherQuery),
        shortQuery: rowsOf(shortQuery), zeroQuery: rowsOf(zeroQuery), badColumn,
      });
    });

    test('hybridSearch: fusion order over the vector arm', async () => {
      await engine.setConfig('embedding_model', MODEL);
      await engine.setConfig('embedding_dimensions', String(dims));
      resetGateway();
      configureGateway({ embedding_model: MODEL, embedding_dimensions: dims, env: { OPENAI_API_KEY: 'synthetic-only' } });
      __setEmbedTransportForTests(async ({ values }) => ({ values, warnings: [], embeddings: values.map(() => Array.from(q)), usage: { tokens: 1 } }) as never);
      const slugs = async (query: string, opts: Record<string, unknown> = {}) =>
        outcome(async () => (await hybridSearch(engine, query, { expansion: false, limit: 10, ...opts } as never)).map((r) => r.slug));
      const cases = {
        vectorOnly: await slugs('nonlexicalsaffronquery'),
        withKeyword: await slugs('person'),
        bothArms: await slugs('body'),
        limit3: await slugs('nonlexicalsaffronquery', { limit: 3 }),
      };
      __setEmbedTransportForTests(null);
      resetGateway();
      // With no keyword hit the fused order is the vector order (the pipeline drops the tied twin and the opposite vector).
      expect(cases.vectorOnly).toEqual({ ok: ['a-exact', 'd-multi', 'n-timeline', 'f-srcb', 'i-private', 'e-person', 'b-tie1'] });
      expect(cases.withKeyword).toEqual({ ok: ['e-person', 'a-exact', 'd-multi', 'n-timeline', 'f-srcb', 'i-private', 'b-tie1'] });
      expect(cases.bothArms).toEqual({ ok: ['a-exact', 'd-multi', 'n-timeline', 'f-srcb', 'i-private', 'b-tie1', 'e-person', 'c-tie2', 'd-multi', 'n-timeline'] });
      expect(cases.limit3).toEqual({ ok: ['a-exact', 'd-multi', 'n-timeline'] });
      record(kind, 'hybrid', cases);
    }, 60_000);

    // Adds its own pages, after the cases that read every page of the shared fixture. Every read hybridSearch makes on the Rust store (page marker and date reads,
    // the supersede, alias, collapse and generated-page reads) feeds the scores and flags compared here.
    test('hybridSearch: ranking stages and page reads over a supersede link, an alias, a redirect and a generated page', async () => {
      const link = (from: string, to: string, type: string) => engine.addLink(from, to, '', type);
      /** A vector close to the query, so the page stays inside the result window. */
      const near = (k: number) => q.map((x, i) => (i === k ? x + 0.6 : x));
      await page('s-old', [near(20)]);
      await page('s-new', [near(21)]);
      await link('s-new', 's-old', 'supersedes');
      await page('r-target', [near(22)], { fm: { status: 'verified' } });
      await page('r-stub', [near(23)], { fm: { redirect_to: 'r-target' } });
      await page('t-auto', [near(24)], { fm: { status: 'unverified', provenance: 'auto-extracted' } });
      await page('t-flagged', [near(25)], { fm: { content_flag: { reason: 'spam', detail: 'x' } } });
      await page('u-dated', [near(26)], { effectiveDate: '2020-01-02T00:00:00Z' });
      await page('zorbit', [near(27)]);
      await page('z-gen', [near(28)], { fm: { dream_generated: true } });
      await link('z-gen', 'zorbit', 'mentions');
      await page('z-before', []);
      await engine.updateSlug('z-before', 'z-after');
      await page('z-after', [near(29)]);
      await engine.setPageAliases('zorbit', 'default', ['zorbit']);
      // Private pages with markers and no chunks, so no search row shows them: only the marker reads below see them.
      await page('h-hidden', [], { fm: { visibility: 'private', content_flag: { reason: 'spam', detail: 'y' }, status: 'unverified', provenance: 'auto-extracted' } });
      await page('h-access', [], { fm: { access: 'private', status: 'draft' } });
      // `visibility` decides when a page has it, so an explicit public page stays readable under a private access key.
      await page('h-public', [], { fm: { visibility: 'public', access: 'private', status: 'review' } });
      // The earlier hybrid case memoized "no supersede edge" for this engine.
      _resetSupersedeProbeForTests();
      resetGateway();
      configureGateway({ embedding_model: MODEL, embedding_dimensions: dims, env: { OPENAI_API_KEY: 'synthetic-only' } });
      await engine.setConfig('embedding_model', MODEL);
      await engine.setConfig('embedding_dimensions', String(dims));
      __setEmbedTransportForTests(async ({ values }) => ({ values, warnings: [], embeddings: values.map(() => Array.from(q)), usage: { tokens: 1 } }) as never);
      const FLAGS = ['superseded_by', 'provenance', 'generated_demotion', 'alias_resolved_boost', 'redirect_to', 'collapsed', 'backlink_count',
        'recency_boost', 'salience_boost', 'graph_boost', 'content_flag', 'status', 'unverified'];
      const show = (list: unknown[]) => (list as Array<Record<string, unknown>>).map((x) => {
        const flags = FLAGS.filter((k) => x[k] !== undefined).map((k) => `${k}=${JSON.stringify(x[k], (_k, val) => (typeof val === 'number' ? Number(val.toFixed(4)) : val))}`);
        return `${x.slug} ${Number(x.score).toFixed(4)}${flags.length ? ' ' + flags.join(' ') : ''}`;
      });
      /** The vector arm's rows, as the post-fusion stages take them. */
      const vectorRows = async () => (await engine.searchVector(q, { limit: 40 })) as unknown as SearchResult[];
      // hybridSearch hands the page marker reads its whole option bag, so the rows keep their content flags, statuses and
      // unverified marks only when the store's marker reads accept the hybrid policy keys.
      const hybrid = async (query: string, opts: Record<string, unknown> = {}) =>
        outcome(async () => show(await hybridSearch(engine, query, { expansion: false, limit: 40, ...opts } as never)));
      // The post-fusion stages with every metadata stage switched on, over the vector arm's rows.
      const every = async (extra: Record<string, unknown> = {}) => outcome(async () => {
        const rowsIn = await vectorRows();
        await runPostFusionStages(engine, rowsIn, { applyBacklinks: true, salience: 'on', recency: 'on', graphSignalsEnabled: true, ...extra } as never);
        return show(rowsIn);
      });
      const markers = async () => outcome(async () => {
        const rowsIn = await vectorRows();
        await stampContentFlags(engine, rowsIn);
        await stampUnverifiedExtractions(engine, rowsIn);
        return show(rowsIn.filter((r) => r.content_flag || r.status));
      });
      // The marker reads called directly with a hybrid-style option bag (settings, a callback, an empty holders list): the
      // same flags and marks come back on both engines. A key that is not in the bag still refuses on the Rust arm.
      const bagOpts = { expansion: false, limit: 40, takesHoldersAllowList: [], onMeta: () => undefined, _queryPrefix: '', _embeddingOptedOut: false };
      const bag = async () => outcome(async () => {
        const rowsIn = await vectorRows();
        const ids = rowsIn.map((r) => r.page_id);
        const name = (id: number) => rowsIn.find((r) => r.page_id === id)!.slug;
        const flags = await engine.getContentFlagsByPageIds(ids, bagOpts as never);
        const marks = await engine.getUnverifiedExtractionPageIds(ids, bagOpts as never);
        return {
          flags: [...flags].map(([id, f]) => `${name(id)} ${f.reason} ${f.detail}`).sort(),
          marks: [...marks].map(([id, m]) => `${name(id)} ${m.status} ${m.unverified}`).sort(),
        };
      });
      // The remote and untrusted path: excludePrivate hides the markers of private pages exactly as it hides their rows.
      const privateBag = async () => outcome(async () => {
        const rowsIn = await vectorRows();
        const hidden = await engine.getPage('h-hidden');
        const access = await engine.getPage('h-access');
        const explicit = await engine.getPage('h-public');
        const extra = [{ page_id: hidden!.id, slug: 'h-hidden' }, { page_id: access!.id, slug: 'h-access' }, { page_id: explicit!.id, slug: 'h-public' }];
        const ids = [...rowsIn.map((r) => r.page_id), ...extra.map((r) => r.page_id)];
        const name = (id: number) => [...rowsIn, ...extra].find((r) => r.page_id === id)!.slug;
        const read = async (extra: Record<string, unknown>) => {
          const flags = await engine.getContentFlagsByPageIds(ids, { ...bagOpts, ...extra } as never);
          const marks = await engine.getUnverifiedExtractionPageIds(ids, { ...bagOpts, ...extra } as never);
          return {
            flags: [...flags].map(([id, f]) => `${name(id)} ${f.reason} ${f.detail}`).sort(),
            marks: [...marks].map(([id, m]) => `${name(id)} ${m.status} ${m.unverified}`).sort(),
          };
        };
        return { open: await read({}), off: await read({ excludePrivate: false }), hiding: await read({ excludePrivate: true }), scoped: await read({ excludePrivate: true, sourceId: 'default' }) };
      });
      if (rust) {
        const ids = (await vectorRows()).map((r) => r.page_id);
        expect(await outcome(() => engine.getContentFlagsByPageIds(ids, { notAnOption: true } as never))).toMatchObject({ refused: 'engine_capability_missing' });
        expect(await outcome(() => engine.getUnverifiedExtractionPageIds(ids, { notAnOption: true } as never))).toMatchObject({ refused: 'engine_capability_missing' });
        // A floor that is no trust tier refuses as a bad argument, never reads without the floor.
        const reads = [
          (opts: unknown) => engine.getContentFlagsByPageIds(ids, opts as never),
          (opts: unknown) => engine.getUnverifiedExtractionPageIds(ids, opts as never),
        ];
        for (const read of reads) {
          expect(await outcome(() => read({ minTrust: 0.5 }))).toMatchObject({ refused: 'invalid_argument' });
          expect(await outcome(() => read({ minTrust: 'trusted' }))).toEqual({ refused: 'invalid_argument', message: 'minTrust: "trusted" names no trust tier' });
        }
      }
      // The marker reads take the trust floor and the flagged-page filter on every engine (every fixture page is `unknown`,
      // none flagged): a floor above `unknown` drops every marker, and suppressFlagged keeps them all.
      const markerTrust = await outcome(async () => {
        const ids = (await vectorRows()).map((r) => r.page_id);
        const count = async (opts: Record<string, unknown>) => ({
          flags: (await engine.getContentFlagsByPageIds(ids, opts as never)).size,
          marks: (await engine.getUnverifiedExtractionPageIds(ids, opts as never)).size,
        });
        return { none: await count({}), unknown: await count({ minTrust: 'unknown' }), agent: await count({ minTrust: 'agent_written' }), flagged: await count({ suppressFlagged: true }) };
      });
      expect(markerTrust).toEqual({ ok: { none: { flags: 1, marks: 2 }, unknown: { flags: 1, marks: 2 }, agent: { flags: 0, marks: 0 }, flagged: { flags: 1, marks: 2 } } });
      record(kind, 'markerTrust', markerTrust);
      // The generated-page demotion reads the entity the query names, the live page at it and the pages linking to it.
      const demotion = async (scope: { excludePrivate?: boolean }) => outcome(async () => {
        const rowsIn = await vectorRows();
        await applyGeneratedDemotion(engine, rowsIn, 'Zorbit', scope);
        return show(rowsIn.filter((r) => r.provenance || r.generated_demotion));
      });
      const cases = {
        plain: await hybrid('nonlexicalsaffronquery'),
        named: await hybrid('Zorbit'),
        // A caller that hides private pages.
        namedPrivate: await hybrid('Zorbit', { excludePrivate: true }),
        stages: await every(),
        // The same stages for a caller that hides private pages: the salience, effective-date, backlink, adjacency and supersede reads all take the page policy.
        stagesPrivate: await every({ excludePrivate: true }),
        // The whole pipeline with every metadata stage on and the page policy set, as a remote search runs it.
        namedPrivateAllStages: await hybrid('Zorbit', { excludePrivate: true, salience: 'on', recency: 'on', graph_signals: true, expansion: false }),
        markers: await markers(),
        bag: await bag(),
        privateBag: await privateBag(),
        demotion: await demotion({ excludePrivate: false }),
        // hybridSearch passes no excludePrivate unless the caller set it, and the demotion then resolves the entity under excludePrivate: true.
        demotionDefault: await demotion({}),
        demotionPrivate: await demotion({ excludePrivate: true }),
      };
      __setEmbedTransportForTests(null);
      resetGateway();
      // The date-dependent row (u-dated has a 2020 effective date, so its recency factor shrinks with the days) is
      // checked on its own; every other row is fixed. The two engines are compared at the end of the file.
      const dated = (cases.stages as { ok: string[] }).ok.find((r) => r.startsWith('u-dated '))!;
      expect(dated).toMatch(/^u-dated 0\.\d{4} recency_boost=1\.0\d*$/);
      expect({ ok: (cases.stages as { ok: string[] }).ok.filter((r) => r !== dated) }).toEqual({ ok: STAGES_WITHOUT_DATED });
      // With the page policy set the private page loses its effective-date boost (and keeps the rest), on both engines.
      const privateStages = (cases.stagesPrivate as { ok: string[] }).ok;
      expect(privateStages.find((r) => r.startsWith('u-dated '))).toMatch(/^u-dated 0\.\d{4} recency_boost=1\.0\d*$/);
      expect({ ok: privateStages.filter((r) => !r.startsWith('u-dated ')) }).toEqual({
        ok: STAGES_WITHOUT_DATED.map((r) => (r.startsWith('i-private ') ? 'i-private 0.0242' : r)),
      });
      const allStages = (cases.namedPrivateAllStages as { ok: string[] }).ok;
      expect(allStages.find((r) => r.startsWith('u-dated '))).toMatch(/^u-dated 0\.\d{4} recency_boost=1\.0\d*$/);
      expect({ ok: allStages.filter((r) => !r.startsWith('u-dated ')) }).toEqual({ ok: HYBRID_NAMED_PRIVATE_ALL_STAGES });
      expect(cases.plain).toEqual({ ok: HYBRID_PLAIN });
      expect(cases.named).toEqual({ ok: HYBRID_NAMED });
      // A caller that hides private pages gets the same rows on both engines: the keyword, title and vector arms all apply the page policy.
      expect(cases.namedPrivate).toEqual({ ok: HYBRID_NAMED_PRIVATE });
      expect(cases.markers).toEqual({ ok: MARKERS });
      expect(cases.bag).toEqual({
        ok: {
          flags: expect.arrayContaining(['t-flagged spam x']),
          marks: expect.arrayContaining(['t-auto unverified true', 'r-target verified false']),
        },
      });
      const everyone = { flags: ['h-hidden spam y', 't-flagged spam x'], marks: ['h-access draft false', 'h-hidden unverified true', 'h-public review false', 'r-target verified false', 't-auto unverified true'] };
      const hiding = { flags: ['t-flagged spam x'], marks: ['h-public review false', 'r-target verified false', 't-auto unverified true'] };
      expect(cases.privateBag).toEqual({ ok: { open: everyone, off: everyone, hiding, scoped: hiding } });
      expect(cases.demotion).toEqual({ ok: DEMOTION });
      expect(cases.demotionDefault).toEqual({ ok: DEMOTION });
      expect(cases.demotionPrivate).toEqual({ ok: DEMOTION });
      record(kind, 'hybrid-stages', cases);
      // Leave the shared fixture as the later cases expect it (the Rust arm runs none of the cases that count chunks).
      if (!rust) await raw(`DELETE FROM pages WHERE slug IN ('s-old', 's-new', 'r-target', 'r-stub', 't-auto', 't-flagged', 'u-dated', 'zorbit', 'z-gen', 'z-after', 'h-hidden', 'h-access', 'h-public')`);
    }, 60_000);

    // Sets its state with SQL and reads embedding-state members; not on the Rust arm.
    test.skipIf(rust)('embedding reads: stored vectors and chunks with embeddings', async () => {
      const ids = await raw(`SELECT cc.id, p.slug, cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id ORDER BY p.slug, cc.chunk_index`);
      const idOf = (name: string) => Number(ids.find((r) => `${r.slug}#${r.chunk_index}` === name)!.id);
      const read = await engine.getEmbeddingsByChunkIds([idOf('d-multi#2'), idOf('o-skip#0'), 999_999]);
      const back = read.get(idOf('d-multi#2'))!;
      const cases = {
        found: [...read.keys()].map((k) => k === idOf('d-multi#2')),
        exactFloat32: back instanceof Float32Array && back.length === dims && back.every((x, i) => x === stored.get('d-multi#2')![i]),
        empty: await outcome(async () => (await engine.getEmbeddingsByChunkIds([])).size),
        unknownColumn: await outcome(async () => (await engine.getEmbeddingsByChunkIds([idOf('a-exact#0')], 'nope')).size),
        chunks: await outcome(async () => (await engine.getChunksWithEmbeddings('d-multi')).map((c) => `${c.chunk_index} ${c.embedding ? (c.embedding as Float32Array).length : 'null'} ${c.model}`)),
        chunksOtherSource: await outcome(async () => (await engine.getChunksWithEmbeddings('f-srcb', { sourceId: 'src-b' })).length),
        chunksWrongSource: await outcome(async () => (await engine.getChunksWithEmbeddings('f-srcb')).length),
        chunksSkipped: await outcome(async () => (await engine.getChunksWithEmbeddings('o-skip')).map((c) => String(c.embedding))),
        chunksMissing: await outcome(async () => (await engine.getChunksWithEmbeddings('nope')).length),
      };
      expect(cases.found).toEqual([true]);
      expect(cases.exactFloat32).toBe(true);
      expect(cases.empty).toEqual({ ok: 0 });
      expect((cases.unknownColumn as { refused: string }).refused).toBe('42703');
      expect(cases.chunks).toEqual({ ok: [`0 ${dims} ${MODEL}`, `1 ${dims} ${MODEL}`, `2 ${dims} ${MODEL}`] });
      // With no sourceId the read matches the slug in any source.
      expect(cases.chunksWrongSource).toEqual({ ok: 1 });
      expect(cases.chunksSkipped).toEqual({ ok: ['null'] });
      record(kind, 'reads', cases);
    });

    // Sets its state with SQL and reads embedding-state members; not on the Rust arm.
    test.skipIf(rust)('stale chunks, signatures and invalidation', async () => {
      const sig = (model: string) => `${model}:${dims}`;
      const stale = async () => ({
        count: await outcome(() => engine.countStaleChunks()),
        chars: await outcome(() => engine.sumStaleChunkChars()),
        list: await outcome(async () => (await engine.listStaleChunks()).map((r) => `${r.slug}#${r.chunk_index} ${r.source_id} ${r.model}`)),
      });
      const cases: Record<string, unknown> = { start: await stale() };
      await raw(`UPDATE content_chunks SET embedding = NULL WHERE page_id = (SELECT id FROM pages WHERE slug = 'd-multi') AND chunk_index = 1`);
      await raw(`UPDATE content_chunks SET embedding = NULL WHERE page_id = (SELECT id FROM pages WHERE slug = 'f-srcb')`);
      cases.twoNulled = await stale();
      cases.sourceB = {
        count: await outcome(() => engine.countStaleChunks({ sourceId: 'src-b' })),
        list: await outcome(async () => (await engine.listStaleChunks({ sourceId: 'src-b' })).map((r) => r.slug)),
      };
      const list = (opts: Record<string, unknown>) => outcome(async () => (await engine.listStaleChunks(opts as never)).map((r) => `${r.slug}#${r.chunk_index}`));
      const first = (await engine.listStaleChunks({ batchSize: 1 }))[0]!;
      cases.paging = {
        batch1: await list({ batchSize: 1 }),
        after: await list({ batchSize: 5, afterPageId: first.page_id, afterChunkIndex: first.chunk_index }),
        recent: await list({ orderBy: 'updated_desc' }),
      };
      const rowShape = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, x instanceof Date ? 'Date' : typeof x]));
      const anyRow = { slug: 'string', chunk_index: 'number', chunk_text: 'string', chunk_source: 'string', model: 'string', token_count: 'object', source_id: 'string', page_id: 'number' };
      cases.rowShape = {
        byPage: rowShape((await engine.listStaleChunks())[0] as never),
        recent: rowShape((await engine.listStaleChunks({ orderBy: 'updated_desc' }))[0] as never),
      };
      expect(cases.rowShape).toEqual({ byPage: anyRow, recent: { ...anyRow, updated_at: 'Date' } });
      cases.setSignature = await outcome(() => engine.setPageEmbeddingSignature('a-exact', { signature: sig('old:model') }));
      cases.setSignatureOtherSource = await outcome(() => engine.setPageEmbeddingSignature('f-srcb', { sourceId: 'src-b', signature: sig(MODEL) }));
      cases.setSignatureMissing = await outcome(() => engine.setPageEmbeddingSignature('nope', { signature: sig(MODEL) }));
      cases.signatures = (await raw(`SELECT slug, embedding_signature FROM pages WHERE embedding_signature IS NOT NULL ORDER BY slug`)).map((r) => `${r.slug} ${r.embedding_signature}`);
      cases.withSignature = {
        count: await outcome(() => engine.countStaleChunks({ signature: sig(MODEL) })),
        countNull: await outcome(() => engine.countStaleChunks({ signature: sig(MODEL), includeNullSignature: true })),
        chars: await outcome(() => engine.sumStaleChunkChars({ signature: sig(MODEL) })),
        charsNull: await outcome(() => engine.sumStaleChunkChars({ signature: sig(MODEL), includeNullSignature: true })),
      };
      cases.invalidateSignature = await outcome(() => engine.invalidateStaleSignatureEmbeddings({ signature: sig(MODEL) }));
      cases.afterSignature = await stale();
      cases.invalidateOtherSource = await outcome(() => engine.invalidateStaleSignatureEmbeddings({ signature: sig('new:model'), sourceId: 'src-b' }));
      await raw(`UPDATE content_chunks SET embedded_text_hash = md5('drift') WHERE page_id IN (SELECT id FROM pages WHERE slug IN ('k-opposite', 'o-skip'))`);
      await raw(`UPDATE content_chunks SET embedded_text_hash = NULL WHERE page_id = (SELECT id FROM pages WHERE slug = 'b-tie1')`);
      cases.invalidateDrift = await outcome(() => engine.invalidateContentDriftEmbeddings());
      cases.invalidateDriftAgain = await outcome(() => engine.invalidateContentDriftEmbeddings());
      cases.afterDrift = await stale();
      cases.searchAfter = await sv(q);
      cases.invalidateNullSignature = await outcome(() => engine.invalidateStaleSignatureEmbeddings({ signature: sig('new:model'), includeNullSignature: true }));
      cases.end = await stale();
      expect(cases.start).toEqual({ count: { ok: 0 }, chars: { ok: 0 }, list: { ok: [] } });
      expect(cases.twoNulled).toEqual({ count: { ok: 2 }, chars: { ok: 27 }, list: { ok: [`d-multi#1 default ${MODEL}`, `f-srcb#0 src-b ${MODEL}`] } });
      expect(cases.paging).toEqual({ batch1: { ok: ['d-multi#1'] }, after: { ok: ['f-srcb#0'] }, recent: { ok: ['f-srcb#0', 'd-multi#1'] } });
      expect(cases.setSignatureMissing).toBe('done');
      expect(cases.signatures).toEqual([`a-exact ${sig('old:model')}`, `f-srcb ${sig(MODEL)}`]);
      // The count includes the archived source's chunks; the invalidation skips archived sources.
      expect(cases.withSignature).toEqual({ count: { ok: 3 }, countNull: { ok: 15 }, chars: { ok: 41 }, charsNull: { ok: 231 } });
      // A chunk already in the target model's space is not invalidated, whatever its page signature says.
      expect(cases.invalidateSignature).toEqual({ ok: 0 });
      // Drift: only an embedded chunk with a non-NULL, mismatched hash on a page that is not embed_skip.
      expect(cases.invalidateDrift).toEqual({ ok: 1 });
      expect(cases.invalidateDriftAgain).toEqual({ ok: 0 });
      expect(cases.invalidateNullSignature).toEqual({ ok: 11 });
      record(kind, 'stale', cases);
    });

    // Sets its state with SQL and reads embedding-state members; not on the Rust arm.
    test.skipIf(rust)('embedding state counts and rows', async () => {
      const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, val) => (k === 'unstamped_created_at_min' && val ? 'set' : val)));
      const cases: Record<string, any> = {
        ops: strip(await outcome(() => engine.readEmbeddingStateCounts({ mode: 'ops', purgeWindowHours: 72 } as never))),
        full: strip(await outcome(() => engine.readEmbeddingStateCounts({ mode: 'full', purgeWindowHours: 72 } as never))),
        fullSourceB: strip(await outcome(() => engine.readEmbeddingStateCounts({ mode: 'full', sourceIds: ['src-b'], purgeWindowHours: 72 } as never))),
        rows: await outcome(async () => ((await engine.listEmbeddingStateRows({ states: ['embedded', 'pending', 'quarantined', 'deleted_page_chunks', 'empty', 'chunkless_healable', 'keyword_only'], limit: 50, purgeWindowHours: 72 } as never)) as unknown as Array<Record<string, unknown>>)
          .map((r) => `${r.state} ${r.source_id} ${r.slug} ${r.chunks} ${r.bytes} ${r.deleted_at ? 'deleted' : '-'} ${r.overdue}`)),
        rowsLimit2: await outcome(async () => ((await engine.listEmbeddingStateRows({ states: ['embedded', 'pending'], limit: 2, purgeWindowHours: 72 } as never)) as unknown as Array<Record<string, unknown>>).map((r) => `${r.state} ${r.slug}`)),
        rowsBySlug: await outcome(async () => ((await engine.listEmbeddingStateRows({ slugs: ['d-multi'], states: ['embedded', 'pending'], limit: 50, purgeWindowHours: 72 } as never)) as unknown as Array<Record<string, unknown>>).map((r) => `${r.state} ${r.slug}`)),
      };
      // ops mode reads 'embedded' from the planner's row estimate: Rust must return a count, not this number.
      const estimate = cases.ops.ok.counts.embedded;
      expect(Number.isInteger(estimate) && estimate >= 0).toBe(true);
      cases.ops.ok.counts.embedded = 'estimate';
      expect(cases.rows.ok.slice(0, 4)).toEqual(['deleted_page_chunks default g-deleted 1 16 deleted false', 'embedded src-arch j-archived 1 17 - false',
        'empty default l-no-chunks 0 16 - false', 'keyword_only default o-skip 1 13 - false']);
      expect(cases.rowsLimit2).toEqual({ ok: ['embedded j-archived', 'pending a-exact'] });
      expect(cases.rowsBySlug).toEqual({ ok: ['pending d-multi'] });
      record(kind, 'state', cases);
    });
  });
}

describe('vectors and embeddings: engines agree', () => {
  test.skipIf(backends.length < 2)('every shared case gives one answer on both engines', () => {
    expect(seen.get('postgres')).toEqual(seen.get('pglite'));
  });

});
