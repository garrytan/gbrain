/**
 * C2 — fact supersession candidates: the keyword arm of
 * `findCandidateDuplicates` and `facts.candidate_fusion` in
 * `listSupersessionCandidates` / `decideSingleFact` (PGLite, in-memory).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import {
  CANDIDATE_FUSION_KEY, SUPERSESSION_CANDIDATE_K, decideSingleFact, listSupersessionCandidates, readCandidateFusion,
} from '../../src/core/facts/single-prepare.ts';

const MODEL = 'synthetic:fusion';
let engine: PGLiteEngine;

beforeAll(async () => {
  // Pin 1536 dims before initSchema (see facts-engine.test.ts for why).
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-candidate-fusion' } });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Calibrate the synthetic model: an uncalibrated model never supersedes by cosine (supersession-threshold.ts).
  await engine.setConfig('facts.supersession_thresholds', JSON.stringify({ [`${MODEL}@1536`]: 0.95 }));
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

/** Unit vector at angle theta from axis 0 toward `axis`; cos(vec(t,a), vec(0,_)) = cos(t). */
const vec = (theta: number, axis = 1): Float32Array => {
  const a = new Float32Array(1536);
  a[0] = Math.cos(theta);
  a[axis] = Math.sin(theta);
  return a;
};
const cosTo = (c: number, axis = 1) => vec(Math.acos(c), axis);

let n = 0;
const entity = () => `companies/fusion-${++n}-${Math.random().toString(36).slice(2, 8)}`;

async function seed(slug: string, fact: string, embedding: Float32Array, extra: Record<string, unknown> = {}): Promise<number> {
  const r = await engine.insertFact({ fact, kind: 'fact', entity_slug: slug, source: 'test', visibility: 'world', embedding, embedding_model: MODEL, ...extra }, { source_id: 'default' });
  return r.id;
}

async function withFusion<T>(mode: string | null, fn: () => Promise<T>): Promise<T> {
  if (mode === null) await engine.unsetConfig(CANDIDATE_FUSION_KEY);
  else await engine.setConfig(CANDIDATE_FUSION_KEY, mode);
  try { return await fn(); } finally { await engine.setConfig(CANDIDATE_FUSION_KEY, 'rrf_free'); }
}

describe('findCandidateDuplicates arm=keyword', () => {
  test('ranks the entity bucket by shared terms, active rows only', async () => {
    const slug = entity();
    const twin = await seed(slug, 'Annual recurring revenue reached $5M in March 2026', cosTo(0.5, 2));
    const partial = await seed(slug, 'Revenue growth slowed in the second quarter', cosTo(0.9, 3));
    const unrelated = await seed(slug, 'Headquarters moved to a new office downtown', cosTo(0.99, 4));
    const expired = await seed(slug, 'Annual recurring revenue reached $3M', cosTo(0.5, 5));
    await engine.expireFact(expired);
    await seed(entity(), 'Annual recurring revenue reached $9M in March 2026', cosTo(0.5, 6));
    const rows = await engine.findCandidateDuplicates('default', slug, 'Annual recurring revenue reached $7M in March 2026',
      { embedding: vec(0), embeddingModel: MODEL, k: 5, arm: 'keyword' });
    const ids = rows.map(r => r.id);
    expect(ids[0]).toBe(twin);
    expect(ids).toContain(partial);
    expect(ids).not.toContain(unrelated);
    expect(ids).not.toContain(expired);
    expect(rows.every(r => r.entity_slug === slug)).toBe(true);
  });

  test('keeps the cosine arm comparability filters and returns nothing for a claim with no terms', async () => {
    const slug = entity();
    await seed(slug, 'Seat count is 40 engineers', cosTo(0.9), { embedding_model: 'other:model' });
    const same = await seed(slug, 'Seat count is 45 engineers', cosTo(0.9));
    const opts = { embedding: vec(0), embeddingModel: MODEL, k: 5, arm: 'keyword' as const };
    expect((await engine.findCandidateDuplicates('default', slug, 'Seat count is 50 engineers', opts)).map(r => r.id)).toEqual([same]);
    expect(await engine.findCandidateDuplicates('default', slug, 'the of and', opts)).toEqual([]);
    expect(await engine.findCandidateDuplicates('default', slug, 'Seat count', { ...opts, embeddingModel: null })).toEqual([]);
  });
});

describe('facts.candidate_fusion', () => {
  test('defaults to rrf_free; unknown values read as the default', async () => {
    expect(await withFusion(null, () => readCandidateFusion(engine))).toBe('rrf_free');
    expect(await withFusion('bogus', () => readCandidateFusion(engine))).toBe('rrf_free');
    expect(await withFusion('interleave', () => readCandidateFusion(engine))).toBe('interleave');
  });

  test('rrf_free is the cosine arm unchanged; interleave carries both arms, capped at k', async () => {
    const slug = entity();
    const lexical: number[] = [];
    const semantic: number[] = [];
    for (let i = 0; i < 6; i++) semantic.push(await seed(slug, `Board meeting notes batch ${i}`, cosTo(0.99 - i * 0.001, 2 + i)));
    for (let i = 0; i < 3; i++) lexical.push(await seed(slug, `Customer churn rate was ${i + 2}% last quarter`, cosTo(0.2, 20 + i)));
    const claim = 'Customer churn rate was 7% last quarter';
    const cosineOnly = await engine.findCandidateDuplicates('default', slug, claim, { embedding: vec(0), embeddingModel: MODEL, k: SUPERSESSION_CANDIDATE_K });
    const current = await listSupersessionCandidates(engine, 'default', slug, claim, vec(0), MODEL, 'rrf_free');
    expect(current.map(r => r.id)).toEqual(cosineOnly.map(r => r.id));
    expect(current.some(r => lexical.includes(r.id))).toBe(false);
    const fused = await listSupersessionCandidates(engine, 'default', slug, claim, vec(0), MODEL, 'interleave');
    expect(fused.length).toBe(SUPERSESSION_CANDIDATE_K);
    expect(fused[0].id).toBe(semantic[0]);
    expect(lexical).toContain(fused[1].id);
    expect(fused.filter(r => lexical.includes(r.id)).length).toBeGreaterThanOrEqual(2);
    expect(new Set(fused.map(r => r.id)).size).toBe(fused.length);
  });

  test('interleave finds a world twin crowded out of the cosine top 5 by private copies; never supersedes a private row', async () => {
    const slug = entity();
    for (let i = 0; i < 5; i++) {
      await seed(slug, `Private note ${i}: funding runway estimate from the board deck`, cosTo(0.995 - i * 0.0005, 2 + i), { visibility: 'private' });
    }
    const twin = await seed(slug, 'Funding runway is 18 months', cosTo(0.97, 10));
    const claim = { fact: 'Funding runway is 24 months', kind: 'fact' as const, visibility: 'world' as const, entity_slug: slug };
    const before = await withFusion('rrf_free', () => decideSingleFact(engine, 'default', claim, vec(0), MODEL));
    expect(before.status).toBe('inserted');
    const after = await withFusion('interleave', () => decideSingleFact(engine, 'default', claim, vec(0), MODEL));
    expect(after.status).toBe('superseded');
    expect(after.candidate?.id).toBe(twin);
    const privateClaim = { ...claim, visibility: 'private' as const, fact: 'Funding runway is 30 months' };
    const priv = await withFusion('interleave', () => decideSingleFact(engine, 'default', privateClaim, vec(0), MODEL));
    expect(priv.candidate?.visibility ?? 'private').toBe('private');
  });

  test('a similar-but-distinct claim below the cosine threshold stays distinct under interleave', async () => {
    const slug = entity();
    await seed(slug, 'Raised a $5M seed round in 2021', cosTo(0.9, 2));
    const claim = { fact: 'Raised a $20M Series A round in 2023', kind: 'fact' as const, visibility: 'world' as const, entity_slug: slug };
    const d = await withFusion('interleave', () => decideSingleFact(engine, 'default', claim, vec(0), MODEL));
    expect(d.status).toBe('inserted');
  });
});
