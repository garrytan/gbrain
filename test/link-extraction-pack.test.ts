/**
 * #3190 — pack-aware plain link extraction.
 *
 * A custom schema pack's `page_types[].path_prefixes`, `link_types[].inference`
 * and `frontmatter_links` must drive `extractPageLinks` /
 * `extractFrontmatterLinks` (the plain fs/db extract path + put_page
 * auto-link), not just the `--ner` path. Three gates pinned here:
 *   1. entity-dir whitelist unions in pack path_prefixes,
 *   2. pack verb regexes are consulted before legacy inferLinkType,
 *   3. pack frontmatter_links extend FRONTMATTER_LINK_MAP (hardcoded map wins
 *      on collision so base-pack-shaped entries can't emit reversed edges).
 * Plus the guard: codegen'd base packs are ignored (their semantics already
 * live in the in-code tables).
 */

import { describe, test, expect } from 'bun:test';
import {
  extractEntityRefs,
  extractPageLinks,
  extractFrontmatterLinks,
  type SlugResolver,
} from '../src/core/link-extraction.ts';
import {
  packLinkExtractionView,
  type PackLinkExtraction,
} from '../src/core/schema-pack/link-inference.ts';
import type { PageType } from '../src/core/types.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

/** Minimal custom-pack view matching the issue's genealogy repro. */
const packView: PackLinkExtraction = {
  link_types: [
    { name: 'parent_of', inference: { regex: '[Pp]arent of \\[' } },
    { name: 'member_of_line', inference: { regex: 'member of the \\[' } },
  ],
  frontmatter_links: [
    { page_type: 'person', fields: ['parents'], link_type: 'parent_of' },
    // Collides with the hardcoded map (company/key_people is incoming
    // works_at) — must be skipped, not applied outgoing.
    { page_type: 'company', fields: ['key_people'], link_type: 'employs' },
  ],
  entity_dirs: ['wiki/people', 'lines'],
};

describe('#3190 gate 1 — pack path_prefixes widen the entity-dir whitelist', () => {
  const content = 'member of the [Pettit](../lines/pettit.md) line and ' +
    'parent of [Harriet](wiki/people/pettit-harriet-emeline-1828.md).';

  test('without extra dirs, non-whitelisted targets yield zero refs', () => {
    expect(extractEntityRefs(content)).toEqual([]);
  });

  test('with pack entity dirs, both targets become candidates', () => {
    const refs = extractEntityRefs(content, packView.entity_dirs);
    expect(refs.map(r => r.slug).sort()).toEqual([
      'lines/pettit',
      'wiki/people/pettit-harriet-emeline-1828',
    ]);
  });

  test('wikilinks honor pack dirs too', () => {
    const refs = extractEntityRefs('[[wiki/people/pettit-james-b-1777|James]]', packView.entity_dirs);
    expect(refs).toHaveLength(1);
    expect(refs[0].slug).toBe('wiki/people/pettit-james-b-1777');
  });
});

describe('#3190 gate 2 — pack verb inference runs on the plain extract path', () => {
  test('pack regex verb wins over legacy mentions', async () => {
    const { candidates } = await extractPageLinks(
      'wiki/people/pettit-james-b-1777',
      'parent of [Harriet](wiki/people/pettit-harriet-emeline-1828.md)',
      {},
      'person' as PageType,
      nullResolver,
      { pack: packView },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].targetSlug).toBe('wiki/people/pettit-harriet-emeline-1828');
    expect(candidates[0].linkType).toBe('parent_of');
  });

  test('no pack verb match falls through to legacy inference', async () => {
    const { candidates } = await extractPageLinks(
      'wiki/people/a',
      'see also [Someone](wiki/people/someone)',
      {},
      'person' as PageType,
      nullResolver,
      { pack: packView },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].linkType).toBe('mentions');
  });

  test('no pack → legacy behavior unchanged (candidate never exists)', async () => {
    const { candidates } = await extractPageLinks(
      'wiki/people/pettit-james-b-1777',
      'parent of [Harriet](wiki/people/pettit-harriet-emeline-1828.md)',
      {},
      'person' as PageType,
      nullResolver,
      {},
    );
    expect(candidates).toEqual([]);
  });
});

describe('#3190 gate 3 — pack frontmatter_links extend FRONTMATTER_LINK_MAP', () => {
  const resolver: SlugResolver = {
    async resolve(name: string, dirHint?: string | string[]) {
      const hints = Array.isArray(dirHint) ? dirHint : (dirHint ? [dirHint] : []);
      // Simulate step-2 resolution: dir-hint + already-slugified value.
      if (hints.includes('wiki/people')) return `wiki/people/${name}`;
      return null;
    },
  };

  test('pack-only field produces an outgoing typed edge', async () => {
    const { candidates, unresolved } = await extractFrontmatterLinks(
      'wiki/people/pettit-harriet-emeline-1828',
      'person' as PageType,
      { parents: ['pettit-james-b-1777', 'felt-lucy-w-1777'] },
      resolver,
      packView,
    );
    expect(unresolved).toEqual([]);
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.linkType).toBe('parent_of');
      expect(c.fromSlug).toBe('wiki/people/pettit-harriet-emeline-1828');
      expect(c.linkSource).toBe('frontmatter');
    }
    expect(candidates.map(c => c.targetSlug).sort()).toEqual([
      'wiki/people/felt-lucy-w-1777',
      'wiki/people/pettit-james-b-1777',
    ]);
  });

  test('hardcoded map wins on colliding (pageType, field) — no reversed duplicate', async () => {
    const trackingResolver: SlugResolver = {
      async resolve(name: string) { return `people/${name}`; },
    };
    const { candidates } = await extractFrontmatterLinks(
      'companies/acme',
      'company' as PageType,
      { key_people: ['alice-example'] },
      trackingResolver,
      packView,
    );
    // Exactly one edge, from the hardcoded incoming works_at mapping —
    // the pack's outgoing 'employs' restatement is skipped.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].linkType).toBe('works_at');
    expect(candidates[0].fromSlug).toBe('people/alice-example');
    expect(candidates[0].targetSlug).toBe('companies/acme');
  });
});

describe('#3190 — packLinkExtractionView', () => {
  const manifest = (over: Record<string, unknown>) => ({
    manifest: {
      name: 'family-pack',
      page_types: [
        { name: 'person', path_prefixes: ['wiki/people/', '/lines/'] },
        { name: 'weird', path_prefixes: ['../evil/', 'ok_dir/'] },
      ],
      link_types: [],
      frontmatter_links: [],
      ...over,
    } as never,
  });

  test('derives slug-safe entity dirs from path_prefixes', () => {
    const view = packLinkExtractionView(manifest({}));
    expect(view).not.toBeNull();
    expect(view!.entity_dirs.sort()).toEqual(['lines', 'ok_dir', 'wiki/people']);
  });

  test('returns null for codegen base packs and missing packs', () => {
    expect(packLinkExtractionView(null)).toBeNull();
    expect(packLinkExtractionView(manifest({ name: 'gbrain-base' }))).toBeNull();
    expect(packLinkExtractionView(manifest({ name: 'gbrain-base-v2' }))).toBeNull();
  });
});
