/**
 * 2026-09 fix wave (#3617 follow-up) — OR-relaxed lexical rows must not
 * outvote a healthy vector arm.
 *
 * Receipt behind the fix: LongMemEval fresh-pin baseline measured hybrid
 * recall_all@5 at 51.3% vs vector-only 93.8%; per-question probing showed
 * gold sessions at vector ranks 0-2 sinking to fused ranks 14-17 because the
 * keyword arm's AND→OR zero-strict-recall fallback (ON in balanced) flooded
 * RRF with common-word matches at full voting weight. The fix: engines TAG
 * fallback rows (`keyword_relaxed`), and hybridSearch drops tagged rows
 * pre-fusion whenever any vector list is non-empty — the fallback keeps its
 * designed rescue role (keyword-only / keyless / embed-outage paths).
 *
 * Serial: mock.module embedding + gateway mutation (same isolation rationale
 * as hybrid-salvage.serial.test.ts, whose mock pattern this seeds from).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as realEmbedding from '../src/core/embedding.ts';

/** Deterministic 1536d unit vector (hybrid-salvage pattern). */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async (text: string) => {
    if (String(text).includes('EMBEDFAIL')) throw new Error('mock embed provider failure');
    return fixedEmbedding();
  },
}));

const { hybridSearch, textVectorArmNonEmpty } = await import('../src/core/search/hybrid.ts');
const { composeFusionLists } = await import('../src/core/search/fusion-lists.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  // Hermetic config home (hybrid-salvage pattern) so a developer's real
  // ~/.gbrain/config.json can't leak an embedding_model into resolution.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-relaxed-'));
  process.env.GBRAIN_HOME = tmpHome;
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Two pages with distinctive non-co-occurring vocabularies. A query like
  // "zephyr walrus" has zero strict websearch recall (no chunk carries both)
  // but broad OR recall (each term matches one page). Chunk embeddings are
  // written directly (test-only) so the vector arm is HEALTHY — the mocked
  // embedQuery returns the same fixed vector, so searchVector matches both.
  const fixtures: Array<[string, string]> = [
    ['notes/zephyr-report', 'The zephyr turbine survey covered coastal ridge lines and marine anemometry.'],
    ['notes/walrus-log', 'The walrus colony census tracked haul-out counts across the northern shelf.'],
  ];
  const vec = `[${Array.from(fixedEmbedding()).join(',')}]`;
  for (const [slug, truth] of fixtures) {
    await engine.putPage(slug, { type: 'note', title: slug.split('/')[1], compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = $1::vector WHERE page_id = (SELECT id FROM pages WHERE slug = $2)`,
      [vec, slug],
    );
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('engine tagging (PGLite; Postgres pinned by the engine-parity e2e)', () => {
  test('zero-strict-recall + orFallback → rows returned AND tagged keyword_relaxed', async () => {
    const rows = await engine.searchKeyword('zephyr walrus', { limit: 10, orFallback: true });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.keyword_relaxed).toBe(true);
  });

  test('strict match → rows NOT tagged (fallback never ran)', async () => {
    const rows = await engine.searchKeyword('zephyr turbine', { limit: 10, orFallback: true });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.keyword_relaxed).toBeUndefined();
  });

  test('no orFallback opt-in → zero-strict-recall stays empty (precision consumers unchanged)', async () => {
    const rows = await engine.searchKeyword('zephyr walrus', { limit: 10 });
    expect(rows).toHaveLength(0);
  });
});

describe('title-arm tagging (PGLite — same fallback class as the keyword arm)', () => {
  test('zero-strict title recall → OR fallback rows tagged; strict title match → untagged', async () => {
    // No single title carries both terms ('zephyr-report' / 'walrus-log'),
    // so strict websearch recall is zero and the always-on OR fallback fires.
    // A missing tag here silently re-opens the outvote bug through the TITLE
    // arm even with the keyword arm fixed (titleFusionList reads the flag).
    const relaxed = await engine.searchTitles('zephyr walrus', { limit: 10 });
    expect(relaxed.length).toBeGreaterThan(0);
    for (const r of relaxed) expect(r.keyword_relaxed).toBe(true);
    // Strict match ('zephyr-report' title carries both tokens): no fallback.
    const strict = await engine.searchTitles('zephyr report', { limit: 10 });
    expect(strict.length).toBeGreaterThan(0);
    for (const r of strict) expect(r.keyword_relaxed).toBeUndefined();
  });
});

describe('hybrid fusion demotion', () => {
  test('healthy vector arm → relaxed rows are dropped pre-fusion (no keyword_relaxed row survives)', async () => {
    // Prove the relaxed pool EXISTS for this query first…
    const relaxed = await engine.searchKeyword('zephyr walrus', { limit: 10, orFallback: true });
    expect(relaxed.length).toBeGreaterThan(0);
    // …then that hybrid (vector arm healthy via mocked embeddings) excludes it.
    const res = await hybridSearch(engine, 'zephyr walrus', { limit: 10, expansion: false });
    expect(res.length).toBeGreaterThan(0); // vector arm carries the response
    for (const r of res) expect(r.keyword_relaxed).toBeUndefined();
  });

  test('vector arm down (embed failure) → relaxed rows still rescue (fallback path unchanged)', async () => {
    const res = await hybridSearch(engine, 'EMBEDFAIL zephyr walrus', { limit: 10, expansion: false });
    expect(res.length).toBeGreaterThan(0);
    // The rescue rows are the OR-fallback pool — tagged, and allowed to serve.
    expect(res.some((r) => r.keyword_relaxed === true)).toBe(true);
  });

  test('muted relaxed rows surface as meta.relaxed_dropped, NOT as a degraded stage (observability without a TTL collapse)', async () => {
    let meta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const res = await hybridSearch(engine, 'zephyr walrus', {
      limit: 10,
      expansion: false,
      onMeta: (m) => { meta = m; },
    });
    expect(res.length).toBeGreaterThan(0);
    expect(meta?.relaxed_dropped ?? 0).toBeGreaterThan(0);
    // Common-case demotion must never look degraded — that would put every
    // zero-strict-lexical query on the 60s cache TTL.
    expect((meta?.degraded ?? []).some((d) => d.stage === 'keyword_relaxed_carried')).toBe(false);
  });
});

describe('hybrid fusion demotion — cross-modal both mode (CRITICAL regression, ranker wave)', () => {
  // The image-side embed is unconfigured in this hermetic setup (no
  // multimodal provider), so a `crossModal: 'both'` query FALLS OPEN to the
  // text path. Pre-roles, `isBothMode = modality==='both' && lists.length>=2`
  // then mis-tagged the LAST text list as the image branch whenever expansion
  // produced ≥ 2 text lists — the demotion gate sliced a real text list off
  // and the fusion mapping handed it imageRrfK. Roles make both read the tag.
  //
  // DISCRIMINATING SHAPE (adversarial finding: the earlier version had a
  // non-empty original list, so the old positional gate still read "healthy"
  // after slicing the last list off and the test could not fail): the
  // ORIGINAL and the FIRST variant vector lists are EMPTY; only the LAST
  // variant returns rows. Old gate: slice(0, -1) → [[], []] → "text arm
  // dead" → relaxed rows carried (relaxed_dropped 0, keyword_relaxed rows in
  // the response). Role gate: any non-empty non-image arm → healthy → muted.
  //
  // Why a searchVector wrapper: engine.searchVector has NO similarity floor
  // (pure distance ORDER BY + LIMIT), so an orthogonal query vector still
  // returns every chunk at cosine 0 — a hermetic "no chunk nearby" list can't
  // be produced by the vector alone. queryEmbedFn maps the original and the
  // first variant to orthogonal basis vectors and the wrapper returns [] for
  // exactly those (the floor a real corpus would impose); the last variant
  // embeds to the fixture vector and hits the engine for real.
  const ORIGINAL = 'zephyr walrus';
  const VARIANT_EMPTY = `${ORIGINAL} survey`;
  const VARIANT_HIT = `${ORIGINAL} census`;
  const twoVariants = async (q: string) => [q, VARIANT_EMPTY, VARIANT_HIT];
  const basis = (dim: number) => { const e = new Float32Array(1536); e[dim] = 1; return e; };
  const ORIG_DIM = 7;
  const EMPTY_VARIANT_DIM = 11;
  const queryEmbedFn = (q: string) =>
    q === ORIGINAL ? basis(ORIG_DIM) : q === VARIANT_EMPTY ? basis(EMPTY_VARIANT_DIM) : fixedEmbedding();
  const isEmptyArmVector = (emb: Float32Array) => emb[ORIG_DIM] === 1 || emb[EMPTY_VARIANT_DIM] === 1;

  async function withEmptyOrthogonalArms<T>(fn: (calls: Float32Array[]) => Promise<T>): Promise<T> {
    const real = engine.searchVector.bind(engine);
    const calls: Float32Array[] = [];
    (engine as unknown as { searchVector: typeof engine.searchVector }).searchVector = async (emb, opts) => {
      calls.push(emb);
      if (isEmptyArmVector(emb)) return [];
      return real(emb, opts);
    };
    try { return await fn(calls); } finally {
      (engine as unknown as { searchVector: typeof engine.searchVector }).searchVector = real;
    }
  }

  test('both mode, fell-open image branch, ONLY the last text list non-empty: the role gate still mutes relaxed rows', async () => {
    let meta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const res = await withEmptyOrthogonalArms(async (calls) => {
      const r = await hybridSearch(engine, ORIGINAL, {
        limit: 10,
        crossModal: 'both',
        expansion: true,
        expandFn: twoVariants,
        queryEmbedFn,
        onMeta: (m) => { meta = m; },
      });
      // Fixture sanity: three text arms ran, in order original → variants,
      // and exactly the first two were the empty (orthogonal) ones.
      expect(calls.length).toBe(3);
      expect(calls.map(isEmptyArmVector)).toEqual([true, true, false]);
      return r;
    });
    expect(meta?.expansion_applied).toBe(true);
    expect(meta?.vector_enabled).toBe(true);
    expect(res.length).toBeGreaterThan(0);
    // The surviving LAST variant list is real semantic evidence → relaxed
    // rows muted, never carried. (Old positional gate: sliced it off → 0.)
    expect(meta?.relaxed_dropped ?? 0).toBeGreaterThan(0);
    for (const r of res) expect(r.keyword_relaxed).toBeUndefined();
    expect((meta?.degraded ?? []).some((d) => d.stage === 'keyword_relaxed_carried')).toBe(false);
  });

  test('same shape, fusion side (pure composeFusionLists): no text list fuses at imageRrfK when the image branch fell open', () => {
    // Exactly the arm shape the live test above produces: original EMPTY,
    // first variant EMPTY, last variant non-empty, NO image arm. The old
    // mapping handed the last list imageRrfK; roles give every text arm vectorK.
    const row = (slug: string) => ({ slug, chunk_text: slug, score: 1 }) as never;
    const ks = { vectorK: 60, textRrfK: 50, imageRrfK: 75, keywordK: 66, baseRrfK: 60 };
    const lists = composeFusionLists({
      arms: [
        { list: [], role: 'original' },
        { list: [], role: 'variant' },
        { list: [row('notes/zephyr-report'), row('notes/walrus-log')], role: 'variant' },
      ],
      keywordFusionList: [], titleFusionList: [], relationalList: [],
      includeRelational: true, ks, knobs: { expansionVariantBudget: null },
    });
    expect(lists.some((l) => l.k === ks.imageRrfK)).toBe(false);
    expect(lists.some((l) => l.k === ks.textRrfK)).toBe(false); // not both-mode either: no image arm
    expect(lists.slice(0, 3).map((l) => l.k)).toEqual([ks.vectorK, ks.vectorK, ks.vectorK]);
  });

  test('both mode, vector arm down: relaxed rows still rescue (fallback path unchanged under roles)', async () => {
    const res = await hybridSearch(engine, 'EMBEDFAIL zephyr walrus', {
      limit: 10,
      crossModal: 'both',
      expansion: false,
    });
    expect(res.length).toBeGreaterThan(0);
    expect(res.some((r) => r.keyword_relaxed === true)).toBe(true);
  });
});

describe('textVectorArmNonEmpty (pure, ROLE-based demotion gate — red-team both-mode finding)', () => {
  const row = (slug: string) => ({ slug, chunk_text: slug, score: 1 }) as never;
  const arm = (role: 'original' | 'variant' | 'clause' | 'image', ...rows: never[]) => ({ list: rows, role });
  test('both mode: a nonempty IMAGE arm alone must NOT mute the lexical rescue (text arms all empty)', () => {
    // arms = [original(empty), image(nonempty)] — pre-fix this read as
    // "vector arm healthy" and dropped the only text-side recall arm.
    expect(textVectorArmNonEmpty([arm('original'), arm('image', row('img/photo'))])).toBe(false);
  });
  test('both mode: any nonempty TEXT arm counts as healthy (image arm irrelevant)', () => {
    expect(textVectorArmNonEmpty([arm('original', row('notes/a')), arm('image')])).toBe(true);
    expect(textVectorArmNonEmpty([arm('original'), arm('variant', row('notes/b')), arm('image')])).toBe(true); // expansion variant hit
    expect(textVectorArmNonEmpty([arm('original'), arm('clause', row('notes/c')), arm('image')])).toBe(true);
  });
  test('text mode: gate reads every arm (no image arm to exclude)', () => {
    expect(textVectorArmNonEmpty([arm('original')])).toBe(false);
    expect(textVectorArmNonEmpty([arm('original'), arm('variant', row('notes/a'))])).toBe(true);
  });
  test('CRITICAL regression: fell-open image branch + two text lists — the last TEXT list is no longer mis-tagged as the image', () => {
    // Pre-roles: isBothMode=true (modality both, 2 lists) sliced the LAST
    // list off as "the image" — here it is the only nonempty TEXT list, so the
    // gate wrongly read the text arm as dead and carried the relaxed rows.
    expect(textVectorArmNonEmpty([arm('original'), arm('variant', row('notes/variant-hit'))])).toBe(true);
    // Fusion side of the same corner: with no image arm, nothing gets imageRrfK.
    const ks = { vectorK: 60, textRrfK: 50, imageRrfK: 75, keywordK: 66, baseRrfK: 60 };
    const lists = composeFusionLists({
      arms: [arm('original'), arm('variant', row('notes/variant-hit'))],
      keywordFusionList: [], titleFusionList: [], relationalList: [],
      includeRelational: true, ks, knobs: { expansionVariantBudget: null },
    });
    expect(lists.some((l) => l.k === ks.imageRrfK)).toBe(false);
    expect(lists.slice(0, 2).map((l) => l.k)).toEqual([ks.vectorK, ks.vectorK]);
  });
});
