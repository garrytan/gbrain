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

describe('linkifyMarkdown — skip zones', () => {
  const map = buildMap([['jessie', ['people/jbryan-aseva']]]);
  const meta = buildMeta([['people/jbryan-aseva', { name: 'Jessie Bryan', domain: 'aseva.com', isAutoStub: false }]]);

  test('frontmatter not scanned', () => {
    const input = '---\ntitle: Jessie meeting\n---\n\nJessie said hi.';
    const result = linkifyMarkdown(input, map, meta, cfgEmpty);
    expect(result.text).toBe('---\ntitle: Jessie meeting\n---\n\n[[people/jbryan-aseva|Jessie]] said hi.');
  });

  test('fenced code block not scanned', () => {
    const input = 'Jessie said:\n```\nJessie in code\n```\nbut Jessie returned.';
    const result = linkifyMarkdown(input, map, meta, cfgEmpty);
    expect(result.text).toContain('Jessie in code');
    expect(result.text).toContain('[[people/jbryan-aseva|Jessie]] returned');
  });

  test('inline code not scanned', () => {
    const input = 'Jessie said `Jessie` in code.';
    const result = linkifyMarkdown(input, map, meta, cfgEmpty);
    expect(result.text).toBe('[[people/jbryan-aseva|Jessie]] said `Jessie` in code.');
  });

  test('existing unqualified wikilink not re-scanned', () => {
    const input = 'See [[people/jbryan-aseva|Jessie]] for details. Jessie said hi.';
    const result = linkifyMarkdown(input, map, meta, cfgEmpty);
    expect(result.text).toBe('See [[people/jbryan-aseva|Jessie]] for details. [[people/jbryan-aseva|Jessie]] said hi.');
  });

  test('existing qualified wikilink not re-scanned', () => {
    const input = 'See [[wiki:people/jbryan-aseva|Jessie]] for details. Jessie said hi.';
    const result = linkifyMarkdown(input, map, meta, cfgEmpty);
    expect(result.text).toBe('See [[wiki:people/jbryan-aseva|Jessie]] for details. [[people/jbryan-aseva|Jessie]] said hi.');
  });

  test('markdown link text not scanned', () => {
    const input = 'See [Jessie](https://example.com/jessie) and Jessie said hi.';
    const result = linkifyMarkdown(input, map, meta, cfgEmpty);
    expect(result.text).toBe('See [Jessie](https://example.com/jessie) and [[people/jbryan-aseva|Jessie]] said hi.');
  });

  test('bare URL not scanned', () => {
    const input = 'See https://example.com/Jessie and Jessie said hi.';
    const result = linkifyMarkdown(input, map, meta, cfgEmpty);
    expect(result.text).toBe('See https://example.com/Jessie and [[people/jbryan-aseva|Jessie]] said hi.');
  });

  test('email address not scanned', () => {
    const input = 'Email Jessie at jessie@aseva.com please.';
    const result = linkifyMarkdown(input, map, meta, cfgEmpty);
    expect(result.text).toBe('Email [[people/jbryan-aseva|Jessie]] at jessie@aseva.com please.');
  });

  test('idempotency: running twice produces same output', () => {
    const input = 'Jessie said hi to Jessie.';
    const once = linkifyMarkdown(input, map, meta, cfgEmpty).text;
    const twice = linkifyMarkdown(once, map, meta, cfgEmpty).text;
    expect(twice).toBe(once);
  });
});

describe('linkifyMarkdown — ambiguity policy', () => {
  const map = buildMap([['cooper', ['people/cself-aseva', 'people/cooper-ciralta']]]);
  const meta = buildMeta([
    ['people/cself-aseva', { name: 'Cooper Self', domain: 'aseva.com', isAutoStub: false }],
    ['people/cooper-ciralta', { name: 'Cooper Smith', domain: 'ciralta.com', isAutoStub: false }],
  ]);

  test('|C|>1 with default-domain tiebreaker links default-domain candidate', () => {
    const cfg = { ...cfgEmpty, defaultDomains: ['aseva.com'] };
    const result = linkifyMarkdown('Cooper said hi.', map, meta, cfg);
    expect(result.text).toBe('[[people/cself-aseva|Cooper]] said hi.');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'resolved_by_default_domain', chosen: 'people/cself-aseva',
    }));
  });

  test('|C|>1 with no default-domain tiebreaker leaves unlinked', () => {
    const result = linkifyMarkdown('Cooper said hi.', map, meta, cfgEmpty);
    expect(result.text).toBe('Cooper said hi.');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: 'ambiguous_unresolved' }));
  });

  test('diagnostic dedup: 5 occurrences → 1 diagnostic with occurrences=5', () => {
    const result = linkifyMarkdown('Cooper, Cooper, Cooper, Cooper, Cooper.', map, meta, cfgEmpty);
    const ambig = result.diagnostics.filter(d => d.kind === 'ambiguous_unresolved');
    expect(ambig).toHaveLength(1);
    expect((ambig[0] as { occurrences: number }).occurrences).toBe(5);
  });
});
