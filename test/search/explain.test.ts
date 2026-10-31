/**
 * Explainable ranking: per-arm RRF attribution, score_details, the `explain`
 * op param, and explain_target diagnosis.
 *
 * Protects: every fused row says which arm instances voted for it at which
 * rank, and those votes sum to its raw RRF score; score_details reports a
 * stage it did not observe as not_run instead of inventing values; `explain`
 * survives the lean MCP projection; explain_target names the first stage
 * that lost a page, and a remote caller asking about a private page gets the
 * same answer as for a page that does not exist.
 * Seams: none for the pure parts; in-memory PGLite (keyless) for the op tests.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SearchResult } from '../../src/core/types.ts';
import { accumulateRrf } from '../../src/core/search/rrf-page-fusion.ts';
import { rrfFusionWeighted } from '../../src/core/search/hybrid.ts';
import { buildScoreDetails } from '../../src/core/search/explain-formatter.ts';
import { TargetTrace, diagnoseProbe, diagnoseTrace } from '../../src/core/search/explain-target.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';

function row(slug: string, chunk_id: number, page_id = chunk_id): SearchResult {
  return {
    slug, page_id, title: slug, type: 'note', chunk_text: slug, chunk_source: 'compiled_truth',
    chunk_id, chunk_index: 0, score: 0, stale: false, source_id: 'default',
  } as SearchResult;
}

describe('RRF arm attribution', () => {
  test('page votes on the lead chunk sum to its raw score; other chunks keep their own votes', () => {
    const a1 = row('notes/a', 1, 10);
    const a2 = row('notes/a', 2, 10);
    const b = row('notes/b', 3, 20);
    const entries = accumulateRrf([
      { list: [a1, b], k: 60, arm: 'vector' },
      { list: [b, a2], k: 60, weight: 0.5, arm: 'vector_variant#1' },
      { list: [a2], k: 60, arm: 'keyword' },
    ]);
    // a2 has the larger own vote (variant 0.5/61 + keyword 1/60 > vector 1/60), so it leads page a.
    const lead = entries.find(e => e.result.chunk_id === 2)!;
    const second = entries.find(e => e.result.chunk_id === 1)!;
    const sum = (e: typeof lead) => e.arms.reduce((t, v) => t + v.contribution, 0);
    expect(lead.arms.every(v => v.vote === 'page')).toBe(true);
    expect(lead.arms.map(v => [v.arm, v.chunk_id])).toEqual([['vector', 1], ['vector_variant#1', 2], ['keyword', 2]]);
    expect(sum(lead)).toBeCloseTo(lead.score, 12);
    expect(second.arms.every(v => v.vote === 'chunk')).toBe(true);
    expect(sum(second)).toBeCloseTo(second.score, 12);
  });

  test('rrfFusionWeighted stamps raw / normalized / compiled-truth factor without changing order', () => {
    const lists = [{ list: [row('notes/a', 1), row('notes/b', 2)], k: 60, arm: 'vector' }, { list: [row('notes/b', 2)], k: 60, arm: 'keyword' }];
    const fused = rrfFusionWeighted(lists, false, true);
    expect(rrfFusionWeighted(lists, false).every(r => r.rrf === undefined)).toBe(true);
    expect(fused.map(r => r.slug)).toEqual(['notes/b', 'notes/a']);
    const b = fused[0];
    expect(b.rrf!.raw).toBeCloseTo(1 / 61 + 1 / 60, 12);
    expect(b.rrf!.normalized).toBe(1);
    expect(b.rrf!.compiled_truth_boost).toBe(1);
    expect(b.rrf!.arms.map(v => [v.arm, v.rank])).toEqual([['vector', 1], ['keyword', 0]]);
  });
});

describe('buildScoreDetails', () => {
  test('unobserved stages are not_run, applied boosts carry their factors, ranks are 1-based', () => {
    const r = { ...row('notes/a', 1), score: 1.2, base_score: 1, backlink_boost: 1.1, backlink_count: 40,
      rrf: { raw: 0.03, normalized: 1, compiled_truth_boost: 1, arms: [{ arm: 'keyword', rank: 0, k: 60, weight: 1, contribution: 1 / 60, vote: 'page' as const, chunk_id: 1 }] } };
    const d = buildScoreDetails(r);
    expect(d.final).toBe(1.2);
    expect(d.arms[0]).toMatchObject({ arm: 'keyword', rank: 1, fusion_rank: 0 });
    expect(d.rrf).toMatchObject({ state: 'applied', raw: 0.03 });
    expect(d.blend).toEqual({ state: 'not_run', reason: 'no_query_embedding' });
    expect(d.rerank.state).toBe('not_run');
    expect(d.boosts.backlink).toEqual({ factor: 1.1, inbound: 40 });
    expect(Object.keys(d.boosts)).toEqual(['backlink']);
  });

  test('a single-arm row says rrf did not run', () => {
    expect(buildScoreDetails(row('notes/a', 1)).rrf).toEqual({ state: 'not_run', reason: 'single_arm_path' });
  });
});

describe('diagnoseTrace', () => {
  const retry = { tool: 'search' as const, arguments: { query: 'q', limit: 2 } };
  test('returned rows report their rank', () => {
    const t = new TargetTrace({ slug: 'notes/a' });
    t.observe('arm:keyword', [row('notes/a', 1)]);
    t.observe('limit_slice', [row('notes/a', 1)]);
    const d = diagnoseTrace(t, [row('notes/a', 1)], retry);
    expect(d).toMatchObject({ state: 'retrieved', code: 'target_returned', rank: 1 });
  });

  test('the first stage that lost the page is named, with a complete retry for the limit', () => {
    const t = new TargetTrace({ slug: 'notes/c' });
    const pool = [row('notes/a', 1), row('notes/b', 2), row('notes/c', 3)];
    t.observe('arm:vector', pool);
    t.observe('fused', pool);
    t.observe('deduped', pool);
    t.observe('return_pool', pool);
    t.observe('limit_slice', pool.slice(0, 2));
    const d = diagnoseTrace(t, pool.slice(0, 2), retry);
    expect(d).toMatchObject({ state: 'dropped', code: 'target_beyond_limit', lost_at: 'limit_slice', last_rank: 3 });
    expect(d.fix?.mcp).toEqual({ tool: 'search', arguments: { query: 'q', limit: 8 } });
  });

  test('a page only the relaxed keyword arm found is attributed to relaxed-row demotion', () => {
    const t = new TargetTrace({ slug: 'notes/x' });
    t.observe('arm:keyword_raw', [row('notes/x', 9)]);
    t.observe('arm:vector', [row('notes/a', 1)]);
    t.observe('arm:keyword', []);
    t.observe('fused', [row('notes/a', 1)]);
    expect(diagnoseTrace(t, [row('notes/a', 1)], retry)).toMatchObject({ state: 'dropped', code: 'target_dropped_relaxed_keyword' });
  });

  test('#7192: a page folded into a kept row is retrieved as target_collapsed at that row', () => {
    const t = new TargetTrace({ slug: 'notes/x-copy' });
    t.observe('arm:keyword', [row('notes/x', 2), row('notes/x-copy', 2)]);
    const kept = { ...row('notes/x', 2), collapsed: [{ slug: 'notes/x-copy', source_id: 'default', reason: 'twin' }] } as SearchResult;
    expect(diagnoseTrace(t, [row('notes/a', 3), kept], retry)).toMatchObject({ state: 'retrieved', code: 'target_collapsed', rank: 2 });
  });

  test('no arm → not_retrieved with an expansion retry; no observations → not_recorded', () => {
    const t = new TargetTrace({ slug: 'notes/x' });
    t.observe('arm:vector', [row('notes/a', 1)]);
    expect(diagnoseTrace(t, [], retry)).toMatchObject({ state: 'not_retrieved', code: 'target_not_retrieved' });
    expect(diagnoseTrace(new TargetTrace({ slug: 'notes/x' }), [], retry).state).toBe('not_recorded');
  });
});

describe('diagnoseProbe', () => {
  const retry = { tool: 'query' as const, arguments: { query: 'q' } };
  const ok = { source_id: 'default', chunks: 2, embedded: 2, current: true, chunker_version: 99 };
  test('absent, ambiguous, unindexed, stale and unsealed pages', () => {
    expect(diagnoseProbe({ slug: 's' }, [], { requireSafeChunks: false, retry })!.code).toBe('target_not_found_or_not_visible');
    const amb = diagnoseProbe({ slug: 's' }, [ok, { ...ok, source_id: 'team' }], { requireSafeChunks: false, retry })!;
    expect(amb.code).toBe('target_ambiguous');
    expect(amb.fix?.mcp?.arguments).toMatchObject({ query: 'q', explain_target: 'default:s' });
    expect(diagnoseProbe({ slug: 's' }, [{ ...ok, chunks: 0 }], { requireSafeChunks: false, retry })!.code).toBe('target_not_indexed');
    expect(diagnoseProbe({ slug: 's' }, [{ ...ok, current: false }], { requireSafeChunks: false, retry })!.code).toBe('target_projection_stale');
    expect(diagnoseProbe({ slug: 's' }, [{ ...ok, chunker_version: 1 }], { requireSafeChunks: true, retry })!.code).toBe('target_safe_chunks_uncertified');
    expect(diagnoseProbe({ slug: 's' }, [ok], { requireSafeChunks: true, retry })).toBeNull();
    expect(diagnoseProbe({ slug: 's' }, [{ ...ok, embedded: 0 }], { requireSafeChunks: false, retry })!.code).toBe('target_not_embedded');
    expect(amb.fix?.argv).toEqual(['gbrain', 'query', 'q', '--explain-target', 'default:s']);
  });
});

describe('search / query ops with explain (PGLite, keyless)', () => {
  let engine: PGLiteEngine;
  const notices: unknown[] = [];
  const metas: Record<string, unknown>[] = [];
  const ctx = (remote: boolean) => ({
    engine, remote, sourceId: 'default', config: { engine: 'pglite', embedding_disabled: true }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    emitNotice: (n: unknown) => { notices.push(n); },
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') metas.push(value as Record<string, unknown>); },
  }) as unknown as OperationContext;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    await importFromContent(engine, 'notes/quokka-habitat', '# Quokka habitat\nQuokka quokka island habitat notes.', { noEmbed: true });
    await importFromContent(engine, 'notes/quokka-diet', '# Quokka diet\nQuokka eats leaves; quokka diet notes.', { noEmbed: true });
    await importFromContent(engine, 'notes/unrelated', '# Ferries\nFerry timetable.', { noEmbed: true });
    await importFromContent(engine, 'notes/secret-quokka', '---\nvisibility: private\n---\n# Secret\nQuokka secret.', { noEmbed: true });
  }, 120_000);
  afterAll(async () => { if (engine) await engine.disconnect(); });

  test('explain: true keeps score_details on lean remote rows; without it rows stay lean', async () => {
    const lean = await operationsByName.search.handler(ctx(true), { query: 'quokka' }) as Array<Record<string, unknown>>;
    expect(lean.length).toBeGreaterThan(0);
    expect(lean.every(r => r.score_details === undefined)).toBe(true);
    const explained = await operationsByName.search.handler(ctx(true), { query: 'quokka', explain: true }) as Array<Record<string, unknown>>;
    expect(explained.every(r => typeof r.score_details === 'object')).toBe(true);
    expect((explained[0].score_details as { final: number }).final).toBe(explained[0].score as number);
  });

  test('explain_target: a returned page reports its rank; a page cut by the limit says so', async () => {
    metas.length = 0;
    await operationsByName.search.handler(ctx(false), { query: 'quokka', explain: true, explain_target: 'notes/quokka-diet' });
    expect(metas.at(-1)?.explain_target).toMatchObject({ state: 'retrieved', code: 'target_returned' });
    const all = await operationsByName.search.handler(ctx(false), { query: 'quokka' }) as SearchResult[];
    expect(all.length).toBeGreaterThan(1);
    metas.length = 0; notices.length = 0;
    await operationsByName.search.handler(ctx(false), { query: 'quokka', limit: 1, explain_target: all[1].slug });
    expect(metas.at(-1)?.explain_target).toMatchObject({ state: 'dropped', code: 'target_beyond_limit', last_rank: 2 });
    expect(notices).toContainEqual(expect.objectContaining({ code: 'target_beyond_limit' }));
    // #7192: the local CLI keeps the fix (rendered into its --json object); a remote caller reads it from the notice only.
    expect((metas.at(-1)?.explain_target as { fix?: { argv?: string[] } }).fix?.argv).toEqual(['gbrain', 'search', 'quokka', '--limit', '7']);
    metas.length = 0;
    await operationsByName.search.handler(ctx(true), { query: 'quokka', limit: 1, explain_target: all[1].slug });
    expect(metas.at(-1)?.explain_target).toMatchObject({ code: 'target_beyond_limit' });
    expect((metas.at(-1)?.explain_target as { fix?: unknown }).fix).toBeUndefined();
  });

  test('a private page and a nonexistent page look identical to a remote caller', async () => {
    metas.length = 0;
    await operationsByName.search.handler(ctx(true), { query: 'quokka', explain_target: 'notes/secret-quokka' });
    const priv = metas.at(-1)?.explain_target as Record<string, unknown>;
    metas.length = 0;
    await operationsByName.search.handler(ctx(true), { query: 'quokka', explain_target: 'notes/does-not-exist' });
    const none = metas.at(-1)?.explain_target as Record<string, unknown>;
    expect(priv.code).toBe('target_not_found_or_not_visible');
    expect({ ...priv, target: null }).toEqual({ ...none, target: null });
  });

  test('query op threads explain_target too', async () => {
    metas.length = 0;
    await operationsByName.query.handler(ctx(false), { query: 'quokka', expand: false, explain_target: 'notes/unrelated' });
    expect((metas.at(-1)?.explain_target as { state: string }).state).toBe('not_retrieved');
    // #7192: a keyless brain has no vectors anywhere; with the semantic arm off on this call, "no vectors" is not the cause.
    expect((metas.at(-1)?.explain_target as { code: string }).code).toBe('target_not_retrieved');
  });
});
