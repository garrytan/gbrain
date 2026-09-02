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

describe('textVectorArmNonEmpty (pure demotion gate — red-team both-mode finding)', () => {
  const row = (slug: string) => ({ slug, chunk_text: slug, score: 1 }) as never;
  test('both mode: a nonempty IMAGE branch alone must NOT mute the lexical rescue (text lists all empty)', () => {
    // vectorLists = [textList(empty), imageList(nonempty)] — pre-fix this
    // read as "vector arm healthy" and dropped the only text-side recall arm.
    expect(textVectorArmNonEmpty([[], [row('img/photo')]], true)).toBe(false);
  });
  test('both mode: any nonempty TEXT list counts as healthy (image branch irrelevant)', () => {
    expect(textVectorArmNonEmpty([[row('notes/a')], []], true)).toBe(true);
    expect(textVectorArmNonEmpty([[], [row('notes/b')], []], true)).toBe(true); // expansion variant hit
  });
  test('text mode: gate reads every list (no image branch to exclude)', () => {
    expect(textVectorArmNonEmpty([[]], false)).toBe(false);
    expect(textVectorArmNonEmpty([[], [row('notes/a')]], false)).toBe(true);
  });
});
