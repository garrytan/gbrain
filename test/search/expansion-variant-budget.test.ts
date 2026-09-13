/**
 * Ranker wave, Phase A — `search.expansion_variant_budget` end-to-end through
 * hybridSearch, DELTA-asserted (pattern: test/search/concept-weights.test.ts).
 *
 * Discriminating corpus (hermetic: in-memory PGLite + deterministic
 * basisEmbedding; no keys, no network):
 *
 *   - gold page:       chunk at the ORIGINAL query's basis dim
 *   - distractor page: chunk at the basis dim BOTH expansion variants map to
 *   - 20 "A" fillers:  cosine 0.8 to the original query, 0 to the variants
 *   - 20 "B" fillers:  cosine 0.8 to the variants, 0 to the original query
 *
 * So the original vector list is [gold, A-fillers…, (cosine-0 tail incl. the
 * distractor)] and each variant list is [distractor, B-fillers…, (tail incl.
 * gold)]: the distractor is a variant-only candidate at rank 0 and gold sinks
 * to rank ≥ 21 in the variant lists — the outvote shape behind the LongMemEval
 * tokenmax regression (RRF is flat, so the fix only bites when the original
 * does NOT also rank the candidate — the fillers manufacture that). Bounds
 * independent of cosine-0 tie order: legacy RRF distractor ≥ 1/101 + 2/60
 * > gold ≤ 1/60 + 2/81; at budget 0.5 gold ≥ 1/60 + 0.5/101 > distractor
 * ≤ 1/81 + 0.5/60. Frozen variants (no LLM) via `expandFn`; `queryEmbedFn`
 * maps original → gold dim, variants → distractor dim. Assert the DIRECTION:
 * budget 0.5 strictly improves gold's score ratio vs the distractor over
 * legacy (null), through BOTH the config key and the per-call seam.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';

const DIM = 1536;
const QUERY = 'which harbor did the survey vessel dock at';
const VARIANTS = ['survey vessel mooring location', 'where the research boat tied up'];
const GOLD_DIM = 21;
const DISTRACTOR_DIM = 22;
const GOLD = 'logs/harbor-survey-dock';
const DISTRACTOR = 'logs/inland-lake-mooring';
const FILLERS_PER_SIDE = 20;

let engine: PGLiteEngine;

const queryEmbedFn = (text: string) => basisEmbedding(text === QUERY ? GOLD_DIM : DISTRACTOR_DIM, DIM);
const expandFn = async (q: string) => [q, ...VARIANTS];

/** Unit vector with cosine 0.8 to basis `mainDim` and 0 to every other fixture dim. */
function leaningEmbedding(mainDim: number, privateDim: number): Float32Array {
  const e = new Float32Array(DIM);
  e[mainDim] = 0.8;
  e[privateDim] = 0.6;
  return e;
}

async function putNote(slug: string, title: string, text: string, embedding: Float32Array): Promise<void> {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: text });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: text,
    chunk_source: 'compiled_truth',
    embedding,
    token_count: 10,
  }]);
}

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Bodies share no tokens with the query or the variants so the lexical arms
  // contribute nothing strict (OR-relaxed rows are muted by the healthy vector
  // arm) and fusion is decided by the vector arms alone.
  await putNote(GOLD, 'Coastal Berth Ledger', 'coastal berth ledger entry recorded on the tenth', basisEmbedding(GOLD_DIM, DIM));
  await putNote(DISTRACTOR, 'Freshwater Pier Ledger', 'freshwater pier logbook line written for the twelfth', basisEmbedding(DISTRACTOR_DIM, DIM));
  for (let i = 0; i < FILLERS_PER_SIDE; i++) {
    await putNote(`fillers/a-${i}`, `Auxiliary Record A${i}`, `auxiliary alpha record number ${i} kept in the archive`, leaningEmbedding(GOLD_DIM, 3000 + i));
    await putNote(`fillers/b-${i}`, `Auxiliary Record B${i}`, `auxiliary beta record number ${i} filed in the cabinet`, leaningEmbedding(DISTRACTOR_DIM, 4000 + i));
  }
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

type Run = { results: Awaited<ReturnType<typeof hybridSearch>>; meta: HybridSearchMeta | undefined; embedded: string[] };

async function run(
  perCall?: { expansionVariantBudget?: number | null },
  overrides?: { expandFn?: (q: string) => Promise<string[]> },
): Promise<Run> {
  let meta: HybridSearchMeta | undefined;
  // Record the ORDER queries reach the embed step: index 0 is the arm the
  // fan-outs tag `original`, so this is the observable for the queries[0]
  // invariant (the role itself is not surfaced on meta).
  const embedded: string[] = [];
  const results = await hybridSearch(engine, QUERY, {
    // Wide limit so every fixture row is returned (fillers can outscore the
    // distractor after the cosine blend; the assertions need both pages).
    limit: 50,
    expansion: true,
    expandFn: overrides?.expandFn ?? expandFn,
    queryEmbedFn: (text: string) => { embedded.push(text); return queryEmbedFn(text); },
    intentWeighting: false,
    onMeta: (m) => { meta = m; },
    ...(perCall ?? {}),
  });
  return { results, meta, embedded };
}

function pick({ results }: Run) {
  const g = results.find((r) => r.slug === GOLD);
  const d = results.find((r) => r.slug === DISTRACTOR);
  expect(g).toBeDefined();
  expect(d).toBeDefined();
  return { g: g!, d: d! };
}

function ratio(r: Run): number {
  const { g, d } = pick(r);
  return g.score / d.score;
}

/**
 * Recover the max-normalized RRF score from the returned blend
 * (cosineReScore: `0.7 * normRrf + 0.3 * cosine`). Every fixture chunk is
 * compiled_truth, so the authority boost cancels. Tied to the blend
 * constants — update here if cosineReScore's weights change.
 */
const normRrf = (r: { score: number; cosine?: number }) => (r.score - 0.3 * (r.cosine ?? 0)) / 0.7;

describe('search.expansion_variant_budget through hybridSearch (hermetic)', () => {
  test('expansion actually fires on the fixture (expansion_applied === true)', async () => {
    const legacy = await run();
    expect(legacy.meta?.expansion_applied).toBe(true);
    expect(legacy.results.length).toBeGreaterThanOrEqual(2);
  });

  test('legacy: two agreeing variants outvote the original at the RRF stage; budget 0.5 flips it', async () => {
    const legacy = pick(await run({ expansionVariantBudget: null }));
    expect(normRrf(legacy.d)).toBeGreaterThan(normRrf(legacy.g));
    const budgeted = pick(await run({ expansionVariantBudget: 0.5 }));
    expect(normRrf(budgeted.g)).toBeGreaterThan(normRrf(budgeted.d));
  });

  test('DIRECTIONAL DELTA via config key: 0.5 strictly improves gold vs the distractor over legacy', async () => {
    // Legacy (key unset → bundle null).
    const legacyRatio = ratio(await run());
    try {
      await engine.setConfig('search.expansion_variant_budget', '0.5');
      const budgeted = await run();
      expect(budgeted.meta?.expansion_applied).toBe(true);
      // Bounds in the header give ≥ 1.49 vs ≤ 1.39 (≥ +7%) regardless of
      // cosine-0 tie order; assert +5% so the margin is real but not knife-edge.
      expect(ratio(budgeted)).toBeGreaterThan(legacyRatio * 1.05);
      // The literal `legacy` restores the pre-knob weighting exactly.
      await engine.setConfig('search.expansion_variant_budget', 'legacy');
      expect(ratio(await run())).toBeCloseTo(legacyRatio, 10);
    } finally {
      await engine.setConfig('search.expansion_variant_budget', 'legacy');
    }
  });

  test('DIRECTIONAL DELTA via the per-call seam: expansionVariantBudget wins over config', async () => {
    const legacyRatio = ratio(await run({ expansionVariantBudget: null }));
    const budgetedRatio = ratio(await run({ expansionVariantBudget: 0.5 }));
    expect(budgetedRatio).toBeGreaterThan(legacyRatio * 1.05);
    // Per-call beats a config value pointing the other way.
    try {
      await engine.setConfig('search.expansion_variant_budget', '0.5');
      expect(ratio(await run({ expansionVariantBudget: null }))).toBeCloseTo(legacyRatio, 10);
    } finally {
      await engine.setConfig('search.expansion_variant_budget', 'legacy');
    }
  });

  test('budget 2.0 with two variants reproduces legacy exactly (weight 1 each)', async () => {
    const legacyRatio = ratio(await run({ expansionVariantBudget: null }));
    expect(ratio(await run({ expansionVariantBudget: 2.0 }))).toBeCloseTo(legacyRatio, 10);
  });

  test('ratio is strictly increasing across the dev-sweep budgets {2.0, 1.0, 0.5, 0.25}', async () => {
    const ratios: number[] = [];
    for (const b of [2.0, 1.0, 0.5, 0.25]) ratios.push(ratio(await run({ expansionVariantBudget: b })));
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
  });
});

describe('per-call expansionVariantBudget seam is range-validated (adversarial finding)', () => {
  // Pre-fix, resolveSearchMode's per-call tier won on `!== undefined`, so a
  // NaN / 0 / -1 / 4.5 per-call value reached fusion (and the knobs hash)
  // unvalidated. Every invalid value must now behave exactly like "unset"
  // (→ config → bundle null = legacy), through the REAL hybridSearch path.
  test('NaN / 0 / -1 / 4.5 / Infinity per-call ≡ legacy (bundle) weighting, byte-for-byte on the ratio', async () => {
    const legacyRatio = ratio(await run({ expansionVariantBudget: null }));
    for (const bad of [Number.NaN, 0, -1, 4.5, Number.POSITIVE_INFINITY]) {
      const r = await run({ expansionVariantBudget: bad });
      expect(r.meta?.expansion_applied).toBe(true);
      expect(ratio(r)).toBeCloseTo(legacyRatio, 10);
    }
  });

  test('the boundary 4 IS accepted (weight 2 per variant here — MORE variant influence than legacy)', async () => {
    const legacyRatio = ratio(await run({ expansionVariantBudget: null }));
    expect(ratio(await run({ expansionVariantBudget: 4 }))).toBeLessThan(legacyRatio);
  });

  test('an invalid per-call value does not mask a valid config override', async () => {
    const legacyRatio = ratio(await run({ expansionVariantBudget: null }));
    try {
      await engine.setConfig('search.expansion_variant_budget', '0.5');
      const viaConfig = ratio(await run());
      expect(viaConfig).toBeGreaterThan(legacyRatio * 1.05);
      // NaN per-call → unset → the 0.5 config override still applies.
      expect(ratio(await run({ expansionVariantBudget: Number.NaN }))).toBeCloseTo(viaConfig, 10);
    } finally {
      await engine.setConfig('search.expansion_variant_budget', 'legacy');
    }
  });
});

describe('queries[0] === query invariant after expandFn (adversarial finding: role tagging trusted expandFn order)', () => {
  // Both fan-outs tag index 0 as the `original` arm. Pre-fix, an expandFn
  // that REORDERED or OMITTED the caller's query handed that anchor role
  // (weight 1 + the cosine re-score vector) to a variant. Observables:
  // (1) the first query embedded is the caller's query; (2) at budget 0.5 the
  // gold page (original-only candidate) still beats the distractor
  // (variant-only candidate) — with the roles swapped, the distractor's
  // list would carry weight 1 and win.
  test('expandFn returns the original LAST: it is still searched first and tagged original', async () => {
    const reordered = async (q: string) => [...VARIANTS, q];
    const r = await run({ expansionVariantBudget: 0.5 }, { expandFn: reordered });
    expect(r.meta?.expansion_applied).toBe(true);
    expect(r.embedded[0]).toBe(QUERY);
    expect(r.embedded).toEqual([QUERY, ...VARIANTS]);
    const { g, d } = pick(r);
    expect(normRrf(g)).toBeGreaterThan(normRrf(d));
    // Byte-identical to the well-ordered expandFn: order of variants preserved.
    expect(ratio(r)).toBeCloseTo(ratio(await run({ expansionVariantBudget: 0.5 })), 10);
  });

  test('expandFn OMITS the original: it is prepended, searched first, tagged original', async () => {
    const omitting = async () => [...VARIANTS];
    const r = await run({ expansionVariantBudget: 0.5 }, { expandFn: omitting });
    expect(r.meta?.expansion_applied).toBe(true);
    expect(r.embedded).toEqual([QUERY, ...VARIANTS]);
    const { g, d } = pick(r);
    expect(normRrf(g)).toBeGreaterThan(normRrf(d));
    expect(ratio(r)).toBeCloseTo(ratio(await run({ expansionVariantBudget: 0.5 })), 10);
  });

  test('duplicate variants (and a repeated original) are deduped so a variant cannot double-vote', async () => {
    const dupes = async (q: string) => [q, VARIANTS[0], q, VARIANTS[0], VARIANTS[1], VARIANTS[1]];
    const r = await run({ expansionVariantBudget: 0.5 }, { expandFn: dupes });
    expect(r.embedded).toEqual([QUERY, ...VARIANTS]);
    expect(ratio(r)).toBeCloseTo(ratio(await run({ expansionVariantBudget: 0.5 })), 10);
  });

  test('expandFn returns [] or only the original: original alone, expansion NOT applied', async () => {
    const empty = await run(undefined, { expandFn: async () => [] });
    expect(empty.embedded).toEqual([QUERY]);
    expect(empty.meta?.expansion_applied).toBe(false);
    const onlyOriginal = await run(undefined, { expandFn: async (q) => [q, q] });
    expect(onlyOriginal.embedded).toEqual([QUERY]);
    expect(onlyOriginal.meta?.expansion_applied).toBe(false);
  });
});
