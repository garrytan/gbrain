/**
 * DB-path ancestor-walk fallback for `extractPageLinks`.
 *
 * `resolveRelativeSlug` (link-extraction.ts) only reconstructs depth when a
 * markdown link carries an explicit `../` (`ref.upLevels > 0`); a
 * dir-prefixed link with NO `../` is treated as already root-relative. The
 * FS-source path's `resolveSlug` (commands/extract.ts) already retries this
 * via an ancestor walk (immediate parent directory first, up to the root)
 * when the direct join misses. The DB-source path (`extract --stale`,
 * `extract links --source db`) had no equivalent retry — this file pins the
 * parity fix: `resolveWithAncestorFallback`, gated on the caller supplying
 * `opts.liveSlugs`.
 *
 * Concrete motivating example: a page at `platform/archive/platform_roadmap`
 * links `decisions/decision-001-architecture-commitment.md` (no `../`), but
 * the real page lives at `platform/decisions/decision-001-architecture-commitment`
 * — one directory up from the page's own containing folder.
 */

import { describe, test, expect } from 'bun:test';
import { extractPageLinks, type SlugResolver } from '../src/core/link-extraction.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

describe('DB-path ancestor-walk fallback (opts.liveSlugs)', () => {
  test('resolves a dir-prefixed link (no ../) against the ancestor directory when the direct target is not live', async () => {
    const liveSlugs = new Set(['platform/decisions/decision-001-architecture-commitment']);
    const { candidates } = await extractPageLinks(
      'platform/archive/platform_roadmap',
      '[The decision](decisions/decision-001-architecture-commitment.md) locked the direction.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, liveSlugs },
    );
    const c = candidates.find(x => x.targetSlug === 'platform/decisions/decision-001-architecture-commitment');
    expect(c).toBeDefined();
    expect(c!.linkSource).toBe('markdown');
  });

  test('negative case: direct root-relative target already live — NOT rewritten by the ancestor walk', async () => {
    const liveSlugs = new Set(['decisions/decision-001-architecture-commitment']);
    const { candidates } = await extractPageLinks(
      'platform/archive/platform_roadmap',
      '[The decision](decisions/decision-001-architecture-commitment.md) locked the direction.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, liveSlugs },
    );
    expect(candidates.map(c => c.targetSlug)).toEqual(['decisions/decision-001-architecture-commitment']);
  });

  test('negative case: no ancestor match anywhere — falls back to the direct (root-relative) target unchanged', async () => {
    const liveSlugs = new Set(['unrelated/other-page']);
    const { candidates } = await extractPageLinks(
      'platform/archive/platform_roadmap',
      '[The decision](decisions/decision-001-architecture-commitment.md) locked the direction.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, liveSlugs },
    );
    // No live target at any ancestor level — resolveCandidateSources (the
    // caller) would drop this; extractPageLinks itself still emits the
    // direct (unresolved) candidate, same as when opts.liveSlugs is absent.
    expect(candidates.map(c => c.targetSlug)).toEqual(['decisions/decision-001-architecture-commitment']);
  });

  test('without opts.liveSlugs, behavior is unchanged from pre-fix (no ancestor retry attempted)', async () => {
    const { candidates } = await extractPageLinks(
      'platform/archive/platform_roadmap',
      '[The decision](decisions/decision-001-architecture-commitment.md) locked the direction.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates.map(c => c.targetSlug)).toEqual(['decisions/decision-001-architecture-commitment']);
  });

  test('nearer ancestor wins when multiple ancestor levels would resolve (walk order: deepest to root)', async () => {
    // Page at a/b/c/page (containing dir a/b/c). Direct target 'x/y' isn't
    // live at root; TWO ancestor levels would resolve it — the nearer one
    // (a/b/x/y, one level up from the page's own dir) must win over the
    // more distant one (a/x/y) since the walk tries nearer ancestors first
    // and returns on first hit.
    const liveSlugs = new Set(['a/b/x/y', 'a/x/y']);
    const { candidates } = await extractPageLinks(
      'a/b/c/page',
      '[Target](x/y.md) text.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, liveSlugs },
    );
    expect(candidates.map(c => c.targetSlug)).toEqual(['a/b/x/y']);
  });
});
