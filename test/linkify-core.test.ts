import { describe, test, expect } from 'bun:test';
import { linkifyMarkdown, type AliasMap, type PageMeta, type LinkifyConfig } from '../src/core/linkify.ts';

function buildMap(entries: Array<[string, string[]]>): AliasMap {
  const m = new Map<string, Set<string>>();
  for (const [k, slugs] of entries) m.set(k, new Set(slugs));
  return m;
}

function buildMeta(entries: Array<[string, Omit<PageMeta, 'slug'>]>): Map<string, PageMeta> {
  const m = new Map<string, PageMeta>();
  for (const [slug, partial] of entries) m.set(slug, { slug, ...partial });
  return m;
}

const cfgEmpty: LinkifyConfig = { defaultDomains: [], stopwords: new Set(), firstMentionOnly: false };

describe('linkifyMarkdown — happy path', () => {
  test('single match, single candidate, links the match', () => {
    const map = buildMap([['jessie', ['people/jbryan-aseva']]]);
    const meta = buildMeta([['people/jbryan-aseva', { name: 'Jessie Bryan', domain: 'aseva.com', isAutoStub: false }]]);
    const result = linkifyMarkdown('Jessie said hello.', map, meta, cfgEmpty);
    expect(result.text).toBe('[[people/jbryan-aseva|Jessie]] said hello.');
    expect(result.counts.linked).toBe(1);
  });

  test('no aliases in map → text unchanged', () => {
    const result = linkifyMarkdown('Jessie said hello.', buildMap([]), buildMeta([]), cfgEmpty);
    expect(result.text).toBe('Jessie said hello.');
  });

  test('preserves display casing (Unicode case-insensitive match)', () => {
    const map = buildMap([['jessie', ['people/jbryan-aseva']]]);
    const meta = buildMeta([['people/jbryan-aseva', { name: 'Jessie Bryan', domain: 'aseva.com', isAutoStub: false }]]);
    expect(linkifyMarkdown('JESSIE said hi.', map, meta, cfgEmpty).text).toBe('[[people/jbryan-aseva|JESSIE]] said hi.');
    expect(linkifyMarkdown('jessie said hi.', map, meta, cfgEmpty).text).toBe('[[people/jbryan-aseva|jessie]] said hi.');
  });
});
