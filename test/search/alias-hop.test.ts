/**
 * T3 — alias hop + ingest projection (the named-thing fix).
 * Hermetic PGLite. applyAliasHop is tested directly (no embedding provider
 * needed); ingest projection is tested via importFromContent(noEmbed).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { applyAliasHop } from '../../src/core/search/hybrid.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function res(slug: string, score: number, title = slug): SearchResult {
  return { slug, title, score, chunk_text: '', type: 'note', source_id: 'default', chunk_index: 0, chunk_id: 1 } as unknown as SearchResult;
}

describe('applyAliasHop', () => {
  test('injects an absent canonical when the query matches its alias', async () => {
    await engine.putPage('projects/mingtang', { type: 'note', title: 'The Mingtang', compiled_truth: 'Indoor Greek amphitheater.' });
    await engine.setPageAliases('projects/mingtang', 'default', ['hall of light', '明堂']);

    const organic = [res('notes/unrelated', 0.5)];
    const out = await applyAliasHop(engine, organic, 'Hall of Light', { sourceId: 'default' });

    const hit = out.find(r => r.slug === 'projects/mingtang');
    expect(hit).toBeDefined();
    expect(hit!.alias_hit).toBe(true);
    expect(out[0].slug).toBe('projects/mingtang'); // injected at top-of-organic + ε
    expect(hit!.score).toBeGreaterThan(0.5);
  });

  test('romanization/CJK alias also resolves', async () => {
    await engine.putPage('projects/mingtang', { type: 'note', title: 'The Mingtang', compiled_truth: 'x' });
    await engine.setPageAliases('projects/mingtang', 'default', ['明堂']);
    const out = await applyAliasHop(engine, [], '明堂', { sourceId: 'default' });
    expect(out.map(r => r.slug)).toContain('projects/mingtang');
  });

  test('boosts (does not duplicate) a canonical already in results', async () => {
    await engine.putPage('projects/mingtang', { type: 'note', title: 'The Mingtang', compiled_truth: 'x' });
    await engine.setPageAliases('projects/mingtang', 'default', ['hall of light']);
    const organic = [res('projects/mingtang', 0.4), res('notes/other', 0.5)];
    const out = await applyAliasHop(engine, organic, 'hall of light', { sourceId: 'default' });
    expect(out.filter(r => r.slug === 'projects/mingtang').length).toBe(1); // no dup
    const m = out.find(r => r.slug === 'projects/mingtang')!;
    expect(m.alias_hit).toBe(true);
    expect(m.score).toBeCloseTo(0.4 * 1.10, 6); // bounded present-boost
  });

  test('P0 source-isolation: alias hop boosts only the aliased source, not the same slug in another source', async () => {
    // The alias belongs to the src-b page only. Two same-slug results, different
    // sources, both in the organic set. The hop must boost ONLY src-b's row.
    await engine.setPageAliases('shared/page', 'src-b', ['only in b']);
    const organic = [
      { slug: 'shared/page', source_id: 'src-a', score: 0.5 } as unknown as SearchResult,
      { slug: 'shared/page', source_id: 'src-b', score: 0.5 } as unknown as SearchResult,
    ];
    const out = await applyAliasHop(engine, organic, 'only in b', { sourceIds: ['src-a', 'src-b'] });
    const a = out.find(r => r.source_id === 'src-a')!;
    const b = out.find(r => r.source_id === 'src-b')!;
    expect(b.alias_hit).toBe(true);
    expect(b.score).toBeCloseTo(0.5 * 1.10, 6);
    expect(a.alias_hit).toBeUndefined(); // NOT cross-boosted
    expect(a.score).toBe(0.5);
  });

  test('no alias match → input unchanged', async () => {
    const organic = [res('a', 0.9), res('b', 0.8)];
    const out = await applyAliasHop(engine, organic, 'some unrelated query', { sourceId: 'default' });
    expect(out.map(r => r.slug)).toEqual(['a', 'b']);
  });

  test('long query is skipped (clearly prose, not a chosen name)', async () => {
    await engine.putPage('p/x', { type: 'note', title: 'X', compiled_truth: 'x' });
    await engine.setPageAliases('p/x', 'default', ['one two three four five six seven']);
    const out = await applyAliasHop(engine, [], 'one two three four five six seven', { sourceId: 'default' });
    expect(out.length).toBe(0); // >6 tokens → skipped
  });

  test('collision: two pages claim one alias → both injected, capped + deterministic', async () => {
    await engine.putPage('a/hall', { type: 'note', title: 'A Hall', compiled_truth: 'x' });
    await engine.putPage('b/hall', { type: 'note', title: 'B Hall', compiled_truth: 'x' });
    await engine.setPageAliases('a/hall', 'default', ['the hall']);
    await engine.setPageAliases('b/hall', 'default', ['the hall']);
    const out = await applyAliasHop(engine, [], 'the hall', { sourceId: 'default' });
    expect(out.map(r => r.slug).sort()).toEqual(['a/hall', 'b/hall']);
  });
});

describe('ingest projection (importFromContent)', () => {
  test('frontmatter aliases: land in page_aliases on import', async () => {
    const md = `---\ntype: note\ntitle: The Mingtang\naliases:\n  - Hall of Light\n  - 明堂\n---\nIndoor Greek amphitheater.`;
    await importFromContent(engine, 'projects/mingtang', md, { sourceId: 'default', noEmbed: true });
    const m = await engine.resolveAliases(['hall of light', '明堂'], { sourceId: 'default' });
    expect((m.get('hall of light') ?? []).map(r => r.slug)).toEqual(['projects/mingtang']);
    expect((m.get('明堂') ?? []).map(r => r.slug)).toEqual(['projects/mingtang']);
  });

  test('removing an alias from frontmatter clears it on re-import', async () => {
    const v1 = `---\ntype: note\ntitle: X\naliases: [old name, keep name]\n---\nbody one`;
    await importFromContent(engine, 'p/x', v1, { sourceId: 'default', noEmbed: true });
    const v2 = `---\ntype: note\ntitle: X\naliases: [keep name]\n---\nbody two changed`;
    await importFromContent(engine, 'p/x', v2, { sourceId: 'default', noEmbed: true });
    const m = await engine.resolveAliases(['old name', 'keep name'], { sourceId: 'default' });
    expect(m.get('old name')).toBeUndefined();
    expect((m.get('keep name') ?? []).map(r => r.slug)).toEqual(['p/x']);
  });
});
