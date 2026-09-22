/**
 * End-to-end wiring of pack-declared `identifier_links[]` rules through
 * `extractPageLinks`. The pure resolution algorithm (pattern -> template ->
 * live-slug lookup) is pinned in test/schema-pack-identifier-links.test.ts;
 * this file pins the integration: candidates land in the SAME
 * `LinkCandidate[]` array as markdown/wikilink/bare-slug/frontmatter
 * candidates, tagged `linkSource: 'identifier'`, respecting the self-loop
 * guard and running alongside the other passes on one page.
 */

import { describe, test, expect } from 'bun:test';
import { extractPageLinks, type SlugResolver } from '../src/core/link-extraction.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

function packWith(identifier_links: Array<Record<string, unknown>>) {
  return parseSchemaPackManifest({
    api_version: 'gbrain-schema-pack-v1',
    name: 'test',
    version: '0.1.0',
    extends: null,
    page_types: [],
    link_types: [],
    identifier_links,
  });
}

describe('extractPageLinks — identifier_links end-to-end', () => {
  test('a bare identifier citation with no slug-shaped text resolves via the pack rule', async () => {
    const pack = packWith([
      { name: 'decision-citation', pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*', link_type: 'cites' },
    ]);
    const liveSlugs = new Set(['decisions/decision-073-architecture-commitment']);
    const { candidates } = await extractPageLinks(
      'notes/some-page',
      'This design follows DECISION-073 and nothing else in the text is slug-shaped.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, pack, liveSlugs },
    );
    const c = candidates.find(x => x.targetSlug === 'decisions/decision-073-architecture-commitment');
    expect(c).toBeDefined();
    expect(c!.linkSource).toBe('identifier');
    expect(c!.linkType).toBe('cites');
  });

  test('no pack supplied: identifier_links step is a no-op (back-compat)', async () => {
    const liveSlugs = new Set(['decisions/decision-073-architecture-commitment']);
    const { candidates } = await extractPageLinks(
      'notes/some-page', 'This design follows DECISION-073.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, liveSlugs }, // no pack
    );
    expect(candidates).toEqual([]);
  });

  test('pack supplied but no opts.liveSlugs: identifier_links step is a no-op (matches put_page/sweep callers)', async () => {
    const pack = packWith([
      { name: 'decision-citation', pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*' },
    ]);
    const { candidates } = await extractPageLinks(
      'notes/some-page', 'This design follows DECISION-073.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, pack }, // no liveSlugs
    );
    expect(candidates).toEqual([]);
  });

  test('self-loop guard: a page citing its own identifier does not link to itself', async () => {
    const pack = packWith([
      { name: 'decision-citation', pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*' },
    ]);
    const liveSlugs = new Set(['decisions/decision-073-architecture-commitment']);
    const { candidates } = await extractPageLinks(
      'decisions/decision-073-architecture-commitment',
      'This page IS DECISION-073.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, pack, liveSlugs },
    );
    expect(candidates).toEqual([]);
  });

  test('identifier candidates coexist with markdown-pass candidates on the same page', async () => {
    const pack = packWith([
      { name: 'decision-citation', pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*' },
    ]);
    const liveSlugs = new Set(['decisions/decision-073-architecture-commitment', 'people/alice']);
    const { candidates } = await extractPageLinks(
      'notes/some-page',
      'Per DECISION-073, [Alice](people/alice.md) owns the rollout.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, pack, liveSlugs },
    );
    const targets = candidates.map(c => c.targetSlug).sort();
    expect(targets).toEqual(['decisions/decision-073-architecture-commitment', 'people/alice']);
    expect(candidates.find(c => c.targetSlug === 'people/alice')!.linkSource).toBe('markdown');
    expect(candidates.find(c => c.targetSlug.startsWith('decisions/'))!.linkSource).toBe('identifier');
  });

  test('identifier match inside a fenced code block is ignored (scans the code-stripped body, same as pass 2)', async () => {
    const pack = packWith([
      { name: 'decision-citation', pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*' },
    ]);
    const liveSlugs = new Set(['decisions/decision-073-architecture-commitment']);
    const { candidates } = await extractPageLinks(
      'notes/some-page',
      '```\n// see DECISION-073 in a comment\n```\nNo other mention here.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, pack, liveSlugs },
    );
    expect(candidates).toEqual([]);
  });
});
