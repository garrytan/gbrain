/**
 * Typed relation lines in link extraction: the stated type applies to the
 * link on its own line only, pack vocabulary gates it, and content without
 * relation lines extracts exactly as before. Pure, no engine.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractPageLinks, type LinkExtractionPack, type SlugResolver } from '../src/core/link-extraction.ts';
import type { PageType } from '../src/core/types.ts';

const nullResolver: SlugResolver = { resolve: async () => null };
const types = async (content: string, opts: Parameters<typeof extractPageLinks>[5] = {}, pageType: PageType = 'person') =>
  (await extractPageLinks('people/alice-example', content, {}, pageType, nullResolver, { skipFrontmatter: true, ...opts }))
    .candidates.map(c => [c.targetSlug, c.linkType]);
const pack = (verbs: string[]): LinkExtractionPack => ({ link_types: verbs.map(name => ({ name })) as never, frontmatter_links: [] });

describe('typed relation lines', () => {
  test('the stated type wins for the link on its line only', async () => {
    const content = 'Alice mentions [[companies/beta-example]] in passing.\n\n- works_at [[companies/acme-example]] (since 2024)\n- invested_in [[companies/widget-co]]';
    expect(await types(content)).toEqual([
      ['companies/beta-example', 'mentions'],
      ['companies/acme-example', 'works_at'],
      ['companies/widget-co', 'invested_in'],
    ]);
  });

  test('a sentence line keeps inference', async () => {
    expect(await types('- works_at [[companies/acme-example]] since 2024')).toEqual([['companies/acme-example', 'mentions']]);
  });

  test('a machine section never applies stated types', async () => {
    expect(await types('## See also\n- works_at [[companies/acme-example]]')).toEqual([['companies/acme-example', 'mentions']]);
  });

  test('pack vocabulary gate, and its opt-out', async () => {
    const content = '- employed_by [[companies/acme-example]]';
    expect(await types(content, { pack: pack(['works_at']) })).toEqual([['companies/acme-example', 'mentions']]);
    expect(await types(content, { pack: pack(['works_at', 'employed_by']) })).toEqual([['companies/acme-example', 'employed_by']]);
    expect(await types(content, { pack: pack(['works_at']), lineGrammar: { allowUndeclaredTypes: true } }))
      .toEqual([['companies/acme-example', 'employed_by']]);
  });

  test('line_grammar disabled restores inference', async () => {
    expect(await types('- works_at [[companies/acme-example]]', { lineGrammar: { enabled: false } }))
      .toEqual([['companies/acme-example', 'mentions']]);
  });

  test('an attended line on a meeting page defers to canonical attendance evidence', async () => {
    const content = 'Attendees: [[people/bob-example]]\n\n- attended [[people/carol-example]]';
    const run = (enabled: boolean) => extractPageLinks('meetings/2026-01-02', content, {}, 'meeting' as PageType, nullResolver,
      { skipFrontmatter: true, lineGrammar: { enabled } }).then(r => r.candidates.map(c => [c.targetSlug, c.linkType, c.canonicalAttendance ?? false]));
    expect(await run(true)).toEqual(await run(false));
  });
});

test('content without relation lines extracts byte-identically with the grammar on or off (BrainBench world-v1 shape)', async () => {
  const fixtures = join(import.meta.dir, 'fixtures');
  const pages = readdirSync(fixtures, { recursive: true }).map(String).filter(f => f.endsWith('.md')).slice(0, 80);
  expect(pages.length).toBeGreaterThan(0);
  for (const file of pages) {
    const content = readFileSync(join(fixtures, file), 'utf-8');
    if (/^\s*(?:[-*+]|\d+[.)])\s+["']?[A-Za-z][\w -]*["']?\s+(?:@\S+\s+)?\[/m.test(content)) continue;
    const on = await extractPageLinks('notes/x', content, {}, 'note' as PageType, nullResolver, { skipFrontmatter: true });
    const off = await extractPageLinks('notes/x', content, {}, 'note' as PageType, nullResolver, { skipFrontmatter: true, lineGrammar: { enabled: false } });
    expect(on.candidates.map(c => [c.targetSlug, c.linkType])).toEqual(off.candidates.map(c => [c.targetSlug, c.linkType]));
  }
});
