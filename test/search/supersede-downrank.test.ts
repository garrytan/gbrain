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
 *     downrank query never runs; one probe per engine per TTL (memoized —
 *     second call issues zero queries); a fresh edge inside the TTL window
 *     is skipped until the probe refreshes (accepted ranking-hint delay)
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

  test('existence gate: zero-edge brain skips the downrank query; probe memoized', async () => {
    const solo = await engine.putPage('notes/solo', { type: 'note', title: 'Solo', compiled_truth: 'x' });
    const calls: string[] = [];
    const orig = engine.executeRaw.bind(engine);
    (engine as { executeRaw: BrainEngine['executeRaw'] }).executeRaw = ((sql: string, params?: unknown[]) => {
      calls.push(sql);
      return orig(sql, params);
    }) as BrainEngine['executeRaw'];
    try {
      const results = [res('notes/solo', solo.id)];
      await applySupersedeDownrank(results, engine);
      // One existence probe, no downrank roundtrip.
      expect(calls.filter(s => s.includes(`link_type = 'supersedes'`) && s.includes('LIMIT 1')).length).toBe(1);
      expect(calls.filter(s => s.includes('to_page_id = ANY')).length).toBe(0);
      expect(results[0].score).toBe(1.0);

      // Second call inside the TTL: memoized, zero additional queries.
      calls.length = 0;
      await applySupersedeDownrank([res('notes/solo', solo.id)], engine);
      expect(calls.length).toBe(0);
    } finally {
      delete (engine as Partial<Record<'executeRaw', unknown>>).executeRaw;
    }
  });

  test('edge minted inside the TTL is skipped until probe reset (ranking-hint delay)', async () => {
    const pre = await engine.putPage('notes/pre', { type: 'note', title: 'Pre', compiled_truth: 'x' });
    // Prime the memo on a zero-edge brain → gate caches false.
    await applySupersedeDownrank([res('notes/pre', pre.id)], engine);

    const { oldId } = await putPair();
    const results = [res('notes/stale', oldId)];
    await applySupersedeDownrank(results, engine);
    expect(results[0].superseded).toBeUndefined(); // still gated by the cached probe

    _resetSupersedeProbeForTests(); // stands in for TTL expiry
    await applySupersedeDownrank(results, engine);
    expect(results[0].superseded).toBe(true);
    expect(results[0].superseded_by).toBe('notes/canon');
  });

  test('probe fail-open: a probe error never kills the stage', async () => {
    const stub = {
      executeRaw: async (sql: string) => {
        if (sql.includes('LIMIT 1')) throw new Error('probe boom');
        return [{ to_page_id: 7, by_slug: 'notes/canon' }];
      },
    } as unknown as BrainEngine;
    const results = [res('notes/stale', 7)];
    await applySupersedeDownrank(results, stub);
    expect(results[0].superseded).toBe(true);
    expect(results[0].superseded_by).toBe('notes/canon');
  });
});
