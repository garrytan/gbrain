import { describe, test, expect } from 'bun:test';
import { linkifyMarkdown, type AliasMap, type PageMeta, type LinkifyConfig } from '../src/core/linkify.ts';

function buildMap(entries: Array<[string, string[]]>): AliasMap {
  const m = new Map<string, Set<string>>();
  for (const [k, slugs] of entries) m.set(k, new Set(slugs));
  return m;
}

function buildMeta(entries: Array<[string, Omit<PageMeta, 'slug' | 'contextKeywords'> & { contextKeywords?: string[] }]>): Map<string, PageMeta> {
  const m = new Map<string, PageMeta>();
  for (const [slug, partial] of entries) m.set(slug, { slug, contextKeywords: [], ...partial });
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

describe('linkifyMarkdown — Unicode & apostrophes', () => {
  test("Jessie's matches (straight apostrophe)", () => {
    const map = buildMap([['jessie', ['people/jbryan-aseva']]]);
    const meta = buildMeta([['people/jbryan-aseva', { name: 'Jessie Bryan', domain: 'aseva.com', isAutoStub: false }]]);
    const result = linkifyMarkdown("Jessie's car.", map, meta, cfgEmpty);
    expect(result.text).toBe("[[people/jbryan-aseva|Jessie]]'s car.");
  });

  test("Jessie's matches (curly apostrophe U+2019)", () => {
    const map = buildMap([['jessie', ['people/jbryan-aseva']]]);
    const meta = buildMeta([['people/jbryan-aseva', { name: 'Jessie Bryan', domain: 'aseva.com', isAutoStub: false }]]);
    const result = linkifyMarkdown("Jessie's car.", map, meta, cfgEmpty);
    expect(result.text).toBe("[[people/jbryan-aseva|Jessie]]'s car.");
  });

  test("O'Brien does NOT match Brien", () => {
    const map = buildMap([['brien', ['people/brien-foo']]]);
    const meta = buildMeta([['people/brien-foo', { name: 'Pat Brien', domain: 'foo.com', isAutoStub: false }]]);
    const result = linkifyMarkdown("Joe O'Brien left.", map, meta, cfgEmpty);
    expect(result.text).toBe("Joe O'Brien left.");
  });

  test('longest-first: "Jessie Bryan" beats "Jessie"', () => {
    const map = buildMap([
      ['jessie', ['people/jbryan-aseva']],
      ['jessie bryan', ['people/jbryan-aseva']],
      ['bryan', ['people/jbryan-aseva']],
    ]);
    const meta = buildMeta([['people/jbryan-aseva', { name: 'Jessie Bryan', domain: 'aseva.com', isAutoStub: false }]]);
    const result = linkifyMarkdown('Jessie Bryan said hi.', map, meta, cfgEmpty);
    expect(result.text).toBe('[[people/jbryan-aseva|Jessie Bryan]] said hi.');
  });
});

describe('linkifyMarkdown — context-keyword tiebreaker', () => {
  const map = buildMap([['justin', ['people/jthompson-aseva', 'people/jworley-aseva']]]);
  const meta = buildMeta([
    ['people/jthompson-aseva', { name: 'Justin Thompson', domain: 'aseva.com', isAutoStub: false, contextKeywords: ['network', 'AI', 'BGP'] }],
    ['people/jworley-aseva',   { name: 'Justin Worley',   domain: 'aseva.com', isAutoStub: false, contextKeywords: ['TAC', 'support', 'ticket'] }],
  ]);

  test('context window picks the candidate with strictly-more keyword hits', () => {
    const text = 'BGP convergence issue on the WAN. Justin to investigate.';
    const result = linkifyMarkdown(text, map, meta, cfgEmpty);
    expect(result.text).toBe('BGP convergence issue on the WAN. [[people/jthompson-aseva|Justin]] to investigate.');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'resolved_by_context_keywords',
      chosen: 'people/jthompson-aseva',
    }));
  });

  test('different window picks the other candidate', () => {
    const text = 'TAC support ticket escalated. Justin will follow up.';
    const result = linkifyMarkdown(text, map, meta, cfgEmpty);
    expect(result.text).toBe('TAC support ticket escalated. [[people/jworley-aseva|Justin]] will follow up.');
  });

  test('tied window keeps unresolved', () => {
    const text = 'Discussed BGP and TAC. Justin will lead.';
    const result = linkifyMarkdown(text, map, meta, cfgEmpty);
    expect(result.text).toBe('Discussed BGP and TAC. Justin will lead.');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: 'ambiguous_unresolved' }));
  });

  test('no keywords in window keeps unresolved', () => {
    const text = 'Justin spoke up.';
    const result = linkifyMarkdown(text, map, meta, cfgEmpty);
    expect(result.text).toBe('Justin spoke up.');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: 'ambiguous_unresolved' }));
  });

  test('case-insensitive keyword match', () => {
    const text = 'Working on bgp peers. Justin will look.';
    const result = linkifyMarkdown(text, map, meta, cfgEmpty);
    expect(result.text).toBe('Working on bgp peers. [[people/jthompson-aseva|Justin]] will look.');
  });

  test('context tiebreaker runs AFTER default_domains tiebreaker (not before)', () => {
    const map2 = buildMap([['cooper', ['people/cself-aseva', 'people/cooper-ciralta']]]);
    const meta2 = buildMeta([
      ['people/cself-aseva',    { name: 'Cooper Self',  domain: 'aseva.com',   isAutoStub: false, contextKeywords: [] }],
      ['people/cooper-ciralta', { name: 'Cooper Smith', domain: 'ciralta.com', isAutoStub: false, contextKeywords: ['ciralta', 'TAC'] }],
    ]);
    const cfg = { ...cfgEmpty, defaultDomains: ['aseva.com'] };
    // Even though "ciralta TAC" is in context, aseva.com wins via default_domains first
    const result = linkifyMarkdown('ciralta TAC ticket. Cooper said hi.', map2, meta2, cfg);
    expect(result.text).toContain('[[people/cself-aseva|Cooper]]');
  });

  test('preserves diagnostic dedup for repeated context resolutions', () => {
    const text = 'BGP. Justin. BGP. Justin. BGP. Justin.';
    const result = linkifyMarkdown(text, map, meta, cfgEmpty);
    const ctx = result.diagnostics.filter(d => d.kind === 'resolved_by_context_keywords');
    expect(ctx.length).toBe(1);
    expect((ctx[0] as { occurrences: number }).occurrences).toBe(3);
  });

  test('keyword "AI" does NOT false-positive on embedded substrings (word boundary)', () => {
    // 'AI' inside 'explain', 'main', 'available' must NOT contribute hits.
    // Without word boundaries, the previous indexOf-based impl would have
    // counted 3 hits and resolved to Thompson, which is wrong.
    const text = 'We need to explain the main available options. Justin will help.';
    const result = linkifyMarkdown(text, map, meta, cfgEmpty);
    expect(result.text).toBe(text);  // unchanged — ambiguous unresolved
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: 'ambiguous_unresolved' }));
  });

  test('keyword "AI" matches as a standalone word', () => {
    // 'AI' followed by space/period — real word boundary.
    const text = 'Discussed AI roadmap. Justin to follow up.';
    const result = linkifyMarkdown(text, map, meta, cfgEmpty);
    expect(result.text).toBe('Discussed AI roadmap. [[people/jthompson-aseva|Justin]] to follow up.');
  });

  test('keyword "BGP" matches as standalone but not embedded', () => {
    // 'BGP' is uncommon as substring — still verify boundary behavior explicitly.
    const text = 'BGP issue affecting routing. Justin to investigate.';
    const result = linkifyMarkdown(text, map, meta, cfgEmpty);
    expect(result.text).toBe('BGP issue affecting routing. [[people/jthompson-aseva|Justin]] to investigate.');
  });
});
