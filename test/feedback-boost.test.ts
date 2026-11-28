/**
 * The use-attributed feedback ranking stage: neutral weights are a no-op,
 * learned weights reorder within [1 - λ, 1 + λ] on the score that orders the
 * list (reranker score when it ran), raw scores stay untouched, and the stage
 * runs on the keyword-only hybrid path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { applyFeedbackStage, feedbackMultiplier } from '../src/core/search/feedback-boost.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { _resetFeedbackSettingsCacheForTests } from '../src/core/feedback/settings.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;
const ids = new Map<string, number>();

async function setWeight(slug: string, weight: number): Promise<void> {
  const [p] = await engine.executeRaw<{ content_hash: string }>('SELECT content_hash FROM pages WHERE slug = $1', [slug]);
  await engine.executeRaw(
    `INSERT INTO retrieval_weights (source_id, element_kind, element_key, weight, content_hash, updates)
     VALUES ('default', 'page', $1, $2, $3, 1)
     ON CONFLICT (source_id, element_kind, element_key) DO UPDATE SET weight = EXCLUDED.weight, content_hash = EXCLUDED.content_hash`,
    [slug, weight, p!.content_hash],
  );
}

function result(slug: string, score: number, rerank?: number): SearchResult {
  return {
    slug, page_id: ids.get(slug)!, title: slug, type: 'note' as never, chunk_text: '', chunk_source: 'compiled_truth',
    chunk_id: 0, chunk_index: 0, score, stale: false, source_id: 'default', ...(rerank !== undefined ? { rerank_score: rerank } : {}),
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const slug of ['notes/renewal-plan-a', 'notes/renewal-plan-b', 'notes/renewal-plan-c']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Renewal plan for the acme-example account (${slug}).` });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Renewal plan for the acme-example account.' }]);
    const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
    ids.set(slug, Number(row!.id));
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM retrieval_weights');
  await engine.executeRaw('DELETE FROM config WHERE key LIKE $1', ['feedback.%']);
  await engine.setConfig('feedback.enabled', 'true');
  _resetFeedbackSettingsCacheForTests();
});

describe('applyFeedbackStage', () => {
  test('neutral weights keep order and scores exactly, and stamp content_hash', async () => {
    const list = [result('notes/renewal-plan-a', 0.9), result('notes/renewal-plan-b', 0.8)];
    const before = list.map(r => [r.slug, r.score]);
    const out = await applyFeedbackStage(engine, list, { reranked: false });
    expect(out.map(r => [r.slug, r.score])).toEqual(before);
    expect(out.every(r => typeof r.content_hash === 'string')).toBe(true);
    expect(out.some(r => r.feedback_boost !== undefined)).toBe(false);
  });

  test('a learned weight reorders within the bound and leaves raw scores alone', async () => {
    await setWeight('notes/renewal-plan-b', 1);
    const list = [result('notes/renewal-plan-a', 0.9), result('notes/renewal-plan-b', 0.85)];
    const out = await applyFeedbackStage(engine, list, { reranked: false });
    expect(out.map(r => r.slug)).toEqual(['notes/renewal-plan-b', 'notes/renewal-plan-a']);
    expect(out[0]!.score).toBe(0.85);
    expect(out[0]!.feedback_boost).toBeCloseTo(feedbackMultiplier(1, 0.1), 6);
    expect(feedbackMultiplier(1, 0.1)).toBeCloseTo(1.1, 6);
    expect(feedbackMultiplier(0, 0.1)).toBeCloseTo(0.9, 6);
  });

  test('a reranked list is ordered by rerank_score; unscored tail rows stay after', async () => {
    await setWeight('notes/renewal-plan-a', 0);
    const list = [
      result('notes/renewal-plan-a', 0.1, 0.9), result('notes/renewal-plan-b', 0.5, 0.85), result('notes/renewal-plan-c', 0.99),
    ];
    const out = await applyFeedbackStage(engine, list, { reranked: true });
    expect(out.map(r => r.slug)).toEqual(['notes/renewal-plan-b', 'notes/renewal-plan-a', 'notes/renewal-plan-c']);
    expect(out[1]!.rerank_score).toBe(0.9);
  });

  test('feedback off: no stamps, no reorder; influence 0: stamps hashes only', async () => {
    await setWeight('notes/renewal-plan-b', 1);
    await engine.setConfig('feedback.enabled', 'false');
    _resetFeedbackSettingsCacheForTests();
    const off = await applyFeedbackStage(engine, [result('notes/renewal-plan-a', 0.9), result('notes/renewal-plan-b', 0.85)], { reranked: false });
    expect(off.map(r => r.slug)).toEqual(['notes/renewal-plan-a', 'notes/renewal-plan-b']);
    expect(off[0]!.content_hash).toBeUndefined();
    await engine.setConfig('feedback.enabled', 'true');
    await engine.setConfig('feedback.influence', '0');
    _resetFeedbackSettingsCacheForTests();
    const zero = await applyFeedbackStage(engine, [result('notes/renewal-plan-a', 0.9), result('notes/renewal-plan-b', 0.85)], { reranked: false });
    expect(zero.map(r => r.slug)).toEqual(['notes/renewal-plan-a', 'notes/renewal-plan-b']);
    expect(typeof zero[0]!.content_hash).toBe('string');
  });
});

describe('applyFeedbackStage on a failed weight read', () => {
  test('a database error leaves the list as it was and counts a stage error', async () => {
    const list = [result('notes/renewal-plan-a', 0.9), result('notes/renewal-plan-b', 0.8)];
    const failing = Object.assign(Object.create(engine), { readPageFeedbackWeights: async () => { throw new Error('boom'); } });
    const metas: unknown[] = [];
    const out = await applyFeedbackStage(failing, list, { reranked: false, onMeta: m => metas.push(m) });
    expect(out.map(r => r.slug)).toEqual(['notes/renewal-plan-a', 'notes/renewal-plan-b']);
    expect(metas).toEqual([{ applied: false, boosted: 0, errored: true }]);
  });

  test('a refused weight read surfaces as the refusal, never as a quietly unboosted list', async () => {
    const list = [result('notes/renewal-plan-a', 0.9)];
    const refusing = Object.assign(Object.create(engine), { readPageFeedbackWeights: async () => { throw capabilityMissing('telemetry', 'readPageFeedbackWeights'); } });
    await expect(applyFeedbackStage(refusing, list, { reranked: false })).rejects.toMatchObject({ code: 'engine_capability_missing' });
  });
});

describe('hybridSearch keyword-only path', () => {
  test('a down-weighted page drops behind an equally matching one', async () => {
    const baseline = await hybridSearch(engine, 'renewal plan acme-example', { limit: 3 });
    expect(baseline.length).toBeGreaterThan(1);
    const top = baseline[0]!.slug;
    await setWeight(top, 0);
    await engine.setConfig('feedback.influence', '0.5');
    _resetFeedbackSettingsCacheForTests();
    const after = await hybridSearch(engine, 'renewal plan acme-example', { limit: 3 });
    expect(after[0]!.slug).not.toBe(top);
    expect(after.find(r => r.slug === top)!.feedback_boost).toBeCloseTo(0.5, 6);
  });
});
