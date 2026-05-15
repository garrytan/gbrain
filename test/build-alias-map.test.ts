import { describe, test, expect } from 'bun:test';
import { buildAliasMap } from '../src/core/linkify.ts';

// Mock engine returning a fixed result set. The real interface has many
// methods; cast as needed. The buildAliasMap function depends on two
// engine methods (queryPersonsForLinkify, countAutoStubsExcludedFromLinkify);
// the mock implements them and ignores the rest of the interface.
function mockEngine(pages: Array<{
  slug: string;
  type: string;
  frontmatter: Record<string, unknown>;
  isAutoStub: boolean;
}>, autoStubExcluded: number = 0): unknown {
  return {
    queryPersonsForLinkify: async () => pages,
    countAutoStubsExcludedFromLinkify: async () => autoStubExcluded,
  };
}

const baseCfg = { defaultDomains: ['aseva.com'], stopwords: new Set<string>(), firstMentionOnly: false };

describe('buildAliasMap', () => {
  test('derives full, first, last tokens from name', async () => {
    const engine = mockEngine([
      { slug: 'people/jbryan-aseva', type: 'person', frontmatter: { name: 'Jessie Bryan', domain: 'aseva.com' }, isAutoStub: false },
    ]);
    const { aliasMap } = await buildAliasMap(engine as never, baseCfg);
    expect(aliasMap.get('jessie bryan')).toEqual(new Set(['people/jbryan-aseva']));
    expect(aliasMap.get('jessie')).toEqual(new Set(['people/jbryan-aseva']));
    expect(aliasMap.get('bryan')).toEqual(new Set(['people/jbryan-aseva']));
  });

  test('auto-stub without linkable: true is excluded', async () => {
    const engine = mockEngine([
      { slug: 'people/huddle-aseva', type: 'person', frontmatter: { name: 'Aseva Huddle Room', domain: 'aseva.com' }, isAutoStub: true },
    ], 1);
    const { aliasMap, startupDiagnostics } = await buildAliasMap(engine as never, baseCfg);
    expect(aliasMap.size).toBe(0);
    expect(startupDiagnostics).toContainEqual(expect.objectContaining({ kind: 'auto_stub_excluded_total', count: 1 }));
  });

  test('stopword filtering drops "will" key but keeps "smith"', async () => {
    const engine = mockEngine([
      { slug: 'people/smith-aseva', type: 'person', frontmatter: { name: 'Will Smith', domain: 'aseva.com' }, isAutoStub: false },
    ]);
    const cfg = { ...baseCfg, stopwords: new Set(['will']) };
    const { aliasMap } = await buildAliasMap(engine as never, cfg);
    expect(aliasMap.has('will')).toBe(false);
    expect(aliasMap.get('smith')).toEqual(new Set(['people/smith-aseva']));
    expect(aliasMap.get('will smith')).toEqual(new Set(['people/smith-aseva']));
  });

  test('all-stopword name emits stopword_dropped_all_keys', async () => {
    const engine = mockEngine([
      { slug: 'people/will-aseva', type: 'person', frontmatter: { name: 'Will', domain: 'aseva.com' }, isAutoStub: false },
    ]);
    const cfg = { ...baseCfg, stopwords: new Set(['will']) };
    const { aliasMap, startupDiagnostics } = await buildAliasMap(engine as never, cfg);
    expect(aliasMap.size).toBe(0);
    expect(startupDiagnostics).toContainEqual(expect.objectContaining({ kind: 'stopword_dropped_all_keys', slug: 'people/will-aseva' }));
  });

  test('apostrophe variant expansion stores both U+0027 and U+2019', async () => {
    const engine = mockEngine([
      { slug: 'people/obrien-foo', type: 'person', frontmatter: { name: "Joe O'Brien", domain: 'foo.com', linkify_aliases: ["O'Brien"] }, isAutoStub: false },
    ]);
    const { aliasMap } = await buildAliasMap(engine as never, baseCfg);
    expect(aliasMap.get("o'brien")).toEqual(new Set(['people/obrien-foo']));
    expect(aliasMap.get("o'brien")).toEqual(new Set(['people/obrien-foo']));
  });

  test('auto-stub WITH linkable: true is included (regression: polarity rule)', async () => {
    const engine = mockEngine([
      { slug: 'people/cself-aseva', type: 'person', frontmatter: { name: 'Cooper Self', domain: 'aseva.com', linkable: true }, isAutoStub: true },
    ], 0);
    const { aliasMap } = await buildAliasMap(engine as never, baseCfg);
    expect(aliasMap.get('cooper')).toEqual(new Set(['people/cself-aseva']));
    expect(aliasMap.get('self')).toEqual(new Set(['people/cself-aseva']));
  });

  test('non-stub WITH linkable: false is excluded', async () => {
    const engine = mockEngine([
      { slug: 'people/excluded-aseva', type: 'person', frontmatter: { name: 'Excluded Person', domain: 'aseva.com', linkable: false }, isAutoStub: false },
    ], 0);
    const { aliasMap } = await buildAliasMap(engine as never, baseCfg);
    expect(aliasMap.size).toBe(0);
  });
});
