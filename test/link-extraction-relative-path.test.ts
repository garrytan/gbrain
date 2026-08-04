/**
 * Relative markdown-link resolution — cross-dir links must resolve against the
 * LINKING page's own directory, not the git root.
 *
 * The markdown-link regex strips the leading `../` run, so `extractPageLinks`
 * historically resolved `[x](../concepts/x.md)` to the root-relative
 * `concepts/x` regardless of where the linking page lived. For the canonical
 * flat layout (entity dirs at the git root, pages one level down) that happens
 * to be correct — `../` unwinds exactly to the root. But for content nested
 * under a prefix — e.g. a source ingested with `--src-subpath wiki`, whose
 * slugs are `wiki/concepts/x` — every cross-dir link missed: the target
 * `concepts/x` doesn't exist, only `wiki/concepts/x` does, so `extract`/sync
 * produced ZERO cross-dir edges (the graph showed only `contains` edges).
 *
 * Fix: preserve the `../` depth (`EntityRef.upLevels`) and resolve the target
 * against the linking page's directory. Backward-compatible — a page one level
 * below the root lands at the root, matching the old behavior; it only diverges
 * (correctly) for deeper nesting. Every "wiki/..." case below FAILS on master.
 */

import { describe, test, expect } from 'bun:test';
import {
  extractPageLinks,
  extractEntityRefs,
  LINK_EXTRACTOR_VERSION_TS,
  type SlugResolver,
} from '../src/core/link-extraction.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

describe('relative markdown-link resolution (nested / subtree-scoped content)', () => {
  test('single ../ resolves against the linking page dir, keeping the prefix (was: dropped)', async () => {
    const { candidates } = await extractPageLinks(
      'wiki/sources/2026-04-03-memory',
      'Builds on [Agent Memory](../concepts/agent-memory.md).',
      {}, 'source', nullResolver, { skipFrontmatter: true },
    );
    const c = candidates.find(x => x.targetSlug === 'wiki/concepts/agent-memory');
    expect(c).toBeDefined();
    expect(c!.linkSource).toBe('markdown');
    // The old root-relative miss must NOT be emitted.
    expect(candidates.map(x => x.targetSlug)).not.toContain('concepts/agent-memory');
  });

  test('multiple ../ walk up multiple directory levels', async () => {
    const { candidates } = await extractPageLinks(
      'wiki/a/b/deep-page',
      'See [X](../../concepts/x.md).',
      {}, 'concept', nullResolver, { skipFrontmatter: true },
    );
    // dir = wiki/a/b ; up 2 -> wiki ; + concepts/x
    expect(candidates.map(c => c.targetSlug)).toContain('wiki/concepts/x');
  });

  test('over-long ../ run clamps at the root', async () => {
    const { candidates } = await extractPageLinks(
      'wiki/foo',
      'See [P](../../../people/alice.md).',
      {}, 'concept', nullResolver, { skipFrontmatter: true },
    );
    expect(candidates.map(c => c.targetSlug)).toContain('people/alice');
  });

  test('absolute engine-slug refs (no ../) are unchanged', async () => {
    const { candidates } = await extractPageLinks(
      'wiki/sources/foo',
      'See [C](concepts/agent-memory) for context.',
      {}, 'source', nullResolver, { skipFrontmatter: true },
    );
    expect(candidates.map(c => c.targetSlug)).toContain('concepts/agent-memory');
    expect(candidates.map(c => c.targetSlug)).not.toContain('wiki/sources/concepts/agent-memory');
  });

  test('extractEntityRefs records the ../ depth as upLevels', () => {
    const refs = extractEntityRefs('[A](../../concepts/x.md) and [B](people/y)');
    const a = refs.find(r => r.slug === 'concepts/x');
    const b = refs.find(r => r.slug === 'people/y');
    expect(a?.upLevels).toBe(2);
    // Absolute refs carry no depth key (treated as 0).
    expect(b?.upLevels ?? 0).toBe(0);
  });

  // ── regression pins: the canonical flat layout must NOT change ──────────

  test('flat layout unchanged: one-level page + single ../ still resolves to root', async () => {
    // notes/index is one level deep, so ../ops/... unwinds to the root exactly
    // as before the fix (this is the #2576 case, kept green here).
    const { candidates } = await extractPageLinks(
      'notes/index', '[Pointer](../ops/services/pointer-agent.md) runs the fleet.',
      {}, 'concept', nullResolver, { skipFrontmatter: true },
    );
    expect(candidates.map(c => c.targetSlug)).toContain('ops/services/pointer-agent');
  });

  test('flat layout unchanged: verb inference still fires on the resolved slug', async () => {
    const { candidates } = await extractPageLinks(
      'people/carol', 'Carol founded [Widget Co](../startups/widget-co.md) in 2024.',
      {}, 'person', nullResolver, { skipFrontmatter: true },
    );
    const c = candidates.find(x => x.targetSlug === 'startups/widget-co');
    expect(c).toBeDefined();
    expect(c!.linkType).toBe('founded');
  });

  test('LINK_EXTRACTOR_VERSION_TS was bumped so stamped pages re-extract', () => {
    // Behavior changed, so previously-stamped pages must re-sweep to pick up
    // the newly-resolvable cross-dir edges.
    expect(LINK_EXTRACTOR_VERSION_TS > '2026-08-01T00:00:00Z').toBe(true);
  });
});
