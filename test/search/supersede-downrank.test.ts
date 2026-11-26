/**
 * applySupersedeDownrank — supersession-aware rerank stage (post-fusion).
 *
 * Hermetic PGLite. Pinned contracts:
 *   - live same-source `supersedes` edge downranks (0.5x) + stamps
 *     superseded / superseded_by / supersede_penalty
 *   - soft-deleted superseder does NOT downrank (pf.deleted_at IS NULL)
 *   - cross-source edge is ignored — no downrank, no superseded_by slug
 *     leaked across the source boundary (within-source contract, matches
 *     relational-recall)
 *   - edge-existence gate: on a brain with zero `supersedes` edges the
 *     downrank query never runs; a "none" answer is never memoized, so an
 *     edge written after it is seen by the very next search; only a "some"
 *     answer is memoized (one probe per engine per TTL, second call issues zero queries)
 *   - probe fail-open: a probe error never kills the stage
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  applySupersedeDownrank,
  SUPERSEDE_PENALTY,
  _resetSupersedeProbeForTests,
} from '../../src/core/search/hybrid.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';

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
  _resetSupersedeProbeForTests();
});

function res(slug: string, page_id: number, source_id = 'default'): SearchResult {
  return {
    slug,
    page_id,
    title: slug,
    type: 'note',
    chunk_text: `body of ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: page_id * 1000,
    chunk_index: 0,
    score: 1.0,
    stale: false,
    source_id,
  } as unknown as SearchResult;
}

async function putPair(opts?: { fromSourceId?: string; toSourceId?: string }): Promise<{ oldId: number }> {
  const fromSrc = opts?.fromSourceId ?? 'default';
  const toSrc = opts?.toSourceId ?? 'default';
  for (const src of new Set([fromSrc, toSrc])) {
    if (src !== 'default') {
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
        [src],
      );
    }
  }
  await engine.putPage('notes/canon', { type: 'note', title: 'Canon', compiled_truth: 'current' }, { sourceId: fromSrc });
  const oldPage = await engine.putPage('notes/stale', { type: 'note', title: 'Stale', compiled_truth: 'old' }, { sourceId: toSrc });
  await engine.addLink('notes/canon', 'notes/stale', '', 'supersedes', 'manual', undefined, undefined, {
    fromSourceId: fromSrc,
    toSourceId: toSrc,
  });
  return { oldId: oldPage.id };
}

describe('applySupersedeDownrank', () => {
  test('live same-source edge downranks and stamps', async () => {
    const { oldId } = await putPair();
    const results = [res('notes/stale', oldId)];
    await applySupersedeDownrank(results, engine);
    expect(results[0].superseded).toBe(true);
    expect(results[0].superseded_by).toBe('notes/canon');
    expect(results[0].supersede_penalty).toBe(SUPERSEDE_PENALTY);
    expect(results[0].score).toBeCloseTo(SUPERSEDE_PENALTY, 6);
  });

  test('soft-deleted superseder no longer downranks', async () => {
    const { oldId } = await putPair();
    await engine.softDeletePage('notes/canon', { sourceId: 'default' });
    const results = [res('notes/stale', oldId)];
    await applySupersedeDownrank(results, engine);
    expect(results[0].superseded).toBeUndefined();
    expect(results[0].superseded_by).toBeUndefined();
    expect(results[0].score).toBe(1.0);
  });

  test('cross-source edge is ignored — no downrank, no superseded_by leak', async () => {
    const { oldId } = await putPair({ fromSourceId: 'other' });
    const results = [res('notes/stale', oldId)];
    await applySupersedeDownrank(results, engine);
    expect(results[0].superseded).toBeUndefined();
    expect(results[0].superseded_by).toBeUndefined();
    expect(results[0].score).toBe(1.0);
  });

  test('existence gate: zero-edge brain skips the downrank query; a zero-edge answer is never memoized', async () => {
    const solo = await engine.putPage('notes/solo', { type: 'note', title: 'Solo', compiled_truth: 'x' });
    const calls: string[] = [];
    const target = engine as unknown as Record<'hasSupersedeEdges' | 'supersedingPageSlugs', (...a: unknown[]) => unknown>;
    const origProbe = target.hasSupersedeEdges;
    const origRead = target.supersedingPageSlugs;
    target.hasSupersedeEdges = (...a: unknown[]) => { calls.push('probe'); return origProbe.apply(engine, a); };
    target.supersedingPageSlugs = (...a: unknown[]) => { calls.push('downrank'); return origRead.apply(engine, a); };
    try {
      const results = [res('notes/solo', solo.id)];
      await applySupersedeDownrank(results, engine);
      // One existence probe, no downrank roundtrip.
      expect(calls).toEqual(['probe']);
      expect(results[0].score).toBe(1.0);

      // Second call: the zero-edge answer was not kept, so the probe runs again (a link written since must be seen).
      calls.length = 0;
      await applySupersedeDownrank([res('notes/solo', solo.id)], engine);
      expect(calls).toEqual(['probe']);
    } finally {
      target.hasSupersedeEdges = origProbe;
      target.supersedingPageSlugs = origRead;
    }
  });

  test('a positive probe is memoized: once edges exist the stage runs without re-probing', async () => {
    const { oldId } = await putPair();
    const calls: string[] = [];
    const target = engine as unknown as Record<'hasSupersedeEdges', (...a: unknown[]) => unknown>;
    const origProbe = target.hasSupersedeEdges;
    target.hasSupersedeEdges = (...a: unknown[]) => { calls.push('probe'); return origProbe.apply(engine, a); };
    try {
      await applySupersedeDownrank([res('notes/stale', oldId)], engine);
      await applySupersedeDownrank([res('notes/stale', oldId)], engine);
      expect(calls).toEqual(['probe']);
    } finally {
      target.hasSupersedeEdges = origProbe;
    }
  });

  test('an edge minted after a zero-edge probe is seen by the very next call', async () => {
    const pre = await engine.putPage('notes/pre', { type: 'note', title: 'Pre', compiled_truth: 'x' });
    await applySupersedeDownrank([res('notes/pre', pre.id)], engine);

    const { oldId } = await putPair();
    const results = [res('notes/stale', oldId)];
    await applySupersedeDownrank(results, engine);
    expect(results[0].superseded).toBe(true);
    expect(results[0].superseded_by).toBe('notes/canon');
  });

  test('probe fail-open: a probe error never kills the stage', async () => {
    const stub = {
      hasSupersedeEdges: async () => { throw new Error('probe boom'); },
      supersedingPageSlugs: async () => new Map([[7, 'notes/canon']]),
    } as unknown as BrainEngine;
    const results = [res('notes/stale', 7)];
    await applySupersedeDownrank(results, stub);
    expect(results[0].superseded).toBe(true);
    expect(results[0].superseded_by).toBe('notes/canon');
  });

  test('a failed downrank read rejects (the post-fusion stage reports supersede_check_failed); a missing links table is an empty answer', async () => {
    const failed = {
      hasSupersedeEdges: async () => true,
      supersedingPageSlugs: async () => { throw new Error('canceling statement due to statement timeout'); },
    } as unknown as BrainEngine;
    await expect(applySupersedeDownrank([res('notes/stale', 7)], failed)).rejects.toThrow(/statement timeout/);
    const preLinks = {
      hasSupersedeEdges: async () => true,
      supersedingPageSlugs: async () => { throw Object.assign(new Error('relation "links" does not exist'), { code: '42P01' }); },
    } as unknown as BrainEngine;
    const results = [res('notes/stale', 7)];
    await applySupersedeDownrank(results, preLinks);
    expect(results[0].superseded).toBeUndefined();
  });

  test('a refused engine capability propagates from the probe and the read', async () => {
    const refusal = Object.assign(new Error('links not served'), { code: 'engine_capability_missing' });
    const probeRefused = {
      hasSupersedeEdges: async () => { throw refusal; },
      supersedingPageSlugs: async () => new Map(),
    } as unknown as BrainEngine;
    await expect(applySupersedeDownrank([res('notes/stale', 7)], probeRefused)).rejects.toBe(refusal);
    _resetSupersedeProbeForTests();
    const readRefused = {
      hasSupersedeEdges: async () => true,
      supersedingPageSlugs: async () => { throw refusal; },
    } as unknown as BrainEngine;
    await expect(applySupersedeDownrank([res('notes/stale', 7)], readRefused)).rejects.toBe(refusal);
  });
});
