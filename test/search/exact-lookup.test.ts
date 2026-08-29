/**
 * #1663 — structural exact-lookup tier (slug / exact-title identity
 * resolution, supersession-filtered). Hermetic PGLite; the tier is tested
 * directly (like alias-hop.test.ts) — no embedding provider needed.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  structuralExactLookup,
  applyExactLookupTier,
  isSlugShapedQuery,
  EXACT_TITLE_STAMP,
} from '../../src/core/search/exact-lookup.ts';
import { _resetSupersedeProbeForTests } from '../../src/core/search/hybrid.ts';
import { classifyEvidence } from '../../src/core/search/evidence.ts';
import type { SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  _resetSupersedeProbeForTests();
});

function res(slug: string, score: number, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    slug, title: slug, score, chunk_text: '', type: 'note', source_id: 'default',
    chunk_index: 0, chunk_id: 1, ...extra,
  } as unknown as SearchResult;
}

describe('isSlugShapedQuery', () => {
  test('slug-shaped tokens qualify; prose and bare words do not', () => {
    expect(isSlugShapedQuery('people/alice-example')).toBe(true);
    expect(isSlugShapedQuery('alice example')).toBe(false);
    expect(isSlugShapedQuery('alice')).toBe(false);
    expect(isSlugShapedQuery('/leading')).toBe(false);
    expect(isSlugShapedQuery('trailing/')).toBe(false);
  });
});

describe('structuralExactLookup (#1663)', () => {
  test('slug-shaped query resolves the page directly (evidence → exists)', async () => {
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'Founder of widget-co.',
    });
    const hits = await structuralExactLookup(engine, 'people/alice-example', { sourceId: 'default' });
    expect(hits.length).toBe(1);
    expect(hits[0].slug).toBe('people/alice-example');
    expect(hits[0].exact_lookup).toBe('slug');
    expect(hits[0].page_id).toBeGreaterThan(0);
    // Evidence contract: identity match reads as 'exists' via alias_hit.
    expect(classifyEvidence(hits[0])).toBe('alias_hit');
  });

  test('exact-title equality matches off the provided title arm (no extra query)', async () => {
    await engine.putPage('projects/mingtang', {
      type: 'note', title: 'The Mingtang', compiled_truth: 'Indoor amphitheater.',
    });
    const page = await engine.getPage('projects/mingtang', { sourceId: 'default' });
    const titleArm = [res('projects/mingtang', 0.4, { title: 'The Mingtang', page_id: page!.id })];
    const hits = await structuralExactLookup(engine, 'the mingtang', {
      sourceId: 'default',
      titleCandidates: titleArm,
    });
    expect(hits.length).toBe(1);
    expect(hits[0].exact_lookup).toBe('title');
    expect(hits[0].title_match_boost).toBeGreaterThanOrEqual(EXACT_TITLE_STAMP);
    expect(classifyEvidence(hits[0])).toBe('exact_title_match');
  });

  test('a PARTIAL title match never qualifies (equality, not phrase)', async () => {
    const titleArm = [res('projects/mingtang', 0.4, { title: 'The Mingtang Amphitheater Notes' })];
    const hits = await structuralExactLookup(engine, 'the mingtang', {
      sourceId: 'default',
      titleCandidates: titleArm,
    });
    expect(hits.length).toBe(0);
  });

  test('non-lookup-shaped queries are a pure no-op', async () => {
    const hits = await structuralExactLookup(
      engine,
      'what were the three big objections raised in the partner meeting last week',
      { sourceId: 'default' },
    );
    expect(hits.length).toBe(0);
  });

  test('supersession filter: a superseded page never wins the identity slot', async () => {
    await engine.putPage('notes/canon', { type: 'note', title: 'Canon', compiled_truth: 'current' });
    await engine.putPage('notes/stale', { type: 'note', title: 'Stale', compiled_truth: 'old' });
    await engine.addLink('notes/canon', 'notes/stale', '', 'supersedes', 'manual');
    const hits = await structuralExactLookup(engine, 'notes/stale', { sourceId: 'default' });
    expect(hits.length).toBe(0); // stale identity match is filtered, not injected
    // The canon page still resolves normally.
    const canonHits = await structuralExactLookup(engine, 'notes/canon', { sourceId: 'default' });
    expect(canonHits.length).toBe(1);
  });

  test('source isolation: scoped probe never resolves another source', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-b', 'team-b') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('shared/page', { type: 'note', title: 'Shared', compiled_truth: 'b' }, { sourceId: 'team-b' });
    const hits = await structuralExactLookup(engine, 'shared/page', { sourceId: 'default' });
    expect(hits.length).toBe(0);
    const scoped = await structuralExactLookup(engine, 'shared/page', { sourceIds: ['team-b'] });
    expect(scoped.length).toBe(1);
    expect(scoped[0].source_id).toBe('team-b');
  });
});

describe('#4480 — shape-filter gating (type/types/excludeSlugs)', () => {
  test('excludeSlugs drops a slug-probe hit the caller filtered out', async () => {
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'Founder.',
    });
    const ungated = await structuralExactLookup(engine, 'people/alice-example', { sourceId: 'default' });
    expect(ungated.length).toBe(1);
    const gated = await structuralExactLookup(engine, 'people/alice-example', {
      sourceId: 'default',
      excludeSlugs: ['people/alice-example'],
    });
    expect(gated.length).toBe(0);
  });

  test('types gate drops hits whose type is outside the filter; matching type passes', async () => {
    await engine.putPage('notes/widget-brief', {
      type: 'note', title: 'Widget Brief', compiled_truth: 'A note.',
    });
    const asPerson = await structuralExactLookup(engine, 'notes/widget-brief', {
      sourceId: 'default',
      types: ['person', 'company'],
    });
    expect(asPerson.length).toBe(0);
    const asNote = await structuralExactLookup(engine, 'notes/widget-brief', {
      sourceId: 'default',
      types: ['note'],
    });
    expect(asNote.length).toBe(1);
  });

  test('scalar type gate applies to title-arm hits too', async () => {
    const titleArm = [res('projects/mingtang', 0.4, { title: 'The Mingtang', type: 'note' })];
    const gated = await structuralExactLookup(engine, 'the mingtang', {
      sourceId: 'default',
      titleCandidates: titleArm,
      type: 'person',
    });
    expect(gated.length).toBe(0);
    const passed = await structuralExactLookup(engine, 'the mingtang', {
      sourceId: 'default',
      titleCandidates: titleArm,
      type: 'note',
    });
    expect(passed.length).toBe(1);
  });
});

describe('applyExactLookupTier (#1663)', () => {
  test('injects an absent identity match at rank-1 above scored organics', async () => {
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'Founder.',
    });
    const organic = [res('notes/unrelated', 0.9), res('notes/other', 0.7)];
    const out = await applyExactLookupTier(engine, organic, 'people/alice-example', { sourceId: 'default' });
    expect(out[0].slug).toBe('people/alice-example');
    expect(out[0].exact_lookup).toBe('slug');
    expect(out[0].score).toBeGreaterThan(0.9);
    expect(out.length).toBe(3);
  });

  test('promotes (does not duplicate) an identity match already in the set', async () => {
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'Founder.',
    });
    const organic = [res('notes/unrelated', 0.9), res('people/alice-example', 0.2)];
    const out = await applyExactLookupTier(engine, organic, 'people/alice-example', { sourceId: 'default' });
    expect(out.filter((r) => r.slug === 'people/alice-example').length).toBe(1);
    expect(out[0].slug).toBe('people/alice-example');
    expect(out[0].exact_lookup).toBe('slug');
  });

  test('no identity match → input unchanged', async () => {
    const organic = [res('a', 0.9), res('b', 0.8)];
    const out = await applyExactLookupTier(engine, organic, 'nonexistent/slug', { sourceId: 'default' });
    expect(out.map((r) => r.slug)).toEqual(['a', 'b']);
  });
});
