/** #7191: pure pieces of gbrain find / stats --by (pattern forms, --by parsing, alias collapse). */
import { describe, expect, test } from 'bun:test';
import { hiddenPrefixesFor, parseFindPattern } from '../src/core/page-find.ts';
import { collapseTypes, groupPageCounts, normalizeTypeName, parseStatsBy } from '../src/core/page-counts.ts';
import { formatFindPages, formatStatsBy } from '../src/cli/format-page-lookup.ts';

describe('parseFindPattern', () => {
  test('a pattern with * or ? is a whole-string glob', () => {
    expect(parseFindPattern('people/*acme*')).toEqual({ kind: 'glob', like: 'people/%acme%', lead: 'people/' });
    expect(parseFindPattern('notes/202?-*')).toEqual({ kind: 'glob', like: 'notes/202_-%', lead: 'notes/202' });
  });
  test('a pattern with a slash is a prefix', () => {
    expect(parseFindPattern('companies/acme')).toEqual({ kind: 'prefix', like: 'companies/acme%', lead: 'companies/acme' });
    expect(parseFindPattern('./companies/')).toEqual({ kind: 'prefix', like: 'companies/%', lead: 'companies/' });
    expect(parseFindPattern('/companies/acme')).toEqual({ kind: 'prefix', like: 'companies/acme%', lead: 'companies/acme' });
  });
  test('anything else is a name substring', () => {
    expect(parseFindPattern('  acme ')).toEqual({ kind: 'name', like: '%acme%', lead: '' });
  });
  test('LIKE metacharacters are escaped in every form', () => {
    expect(parseFindPattern('100%_x').like).toBe('%100\\%\\_x%');
    expect(parseFindPattern('a\\b/*').like).toBe('a\\\\b/%');
  });
  test('hard-exclude prefixes stay hidden unless the pattern targets one', () => {
    const excluded = ['test/', 'attachments/', '.raw/'];
    expect(hiddenPrefixesFor(parseFindPattern('people/*'), excluded)).toEqual(excluded);
    expect(hiddenPrefixesFor(parseFindPattern('acme'), excluded)).toEqual(excluded);
    expect(hiddenPrefixesFor(parseFindPattern('test/fixtures'), excluded)).toEqual(['attachments/', '.raw/']);
    expect(hiddenPrefixesFor(parseFindPattern('Attachments/*.png'), excluded)).toEqual(['test/', '.raw/']);
    expect(hiddenPrefixesFor(parseFindPattern('*/test/x'), excluded)).toEqual(excluded);
  });
  test('an empty pattern throws', () => {
    expect(() => parseFindPattern('   ')).toThrow();
    expect(() => parseFindPattern('./')).toThrow();
  });
});

describe('parseStatsBy', () => {
  test('dimensions in canonical order, deduplicated, case-insensitive', () => {
    expect(parseStatsBy('type,source')).toEqual(['source', 'type']);
    expect(parseStatsBy(' Source , source ')).toEqual(['source']);
    expect(parseStatsBy(['type'])).toEqual(['type']);
    expect(parseStatsBy(undefined)).toEqual([]);
  });
  test('an unknown dimension or a non-string throws, naming the value', () => {
    expect(() => parseStatsBy('source,author')).toThrow(/"author"/);
    expect(() => parseStatsBy(42)).toThrow();
  });
});

describe('type alias collapse', () => {
  test('normalization: last path segment, lower case, singular', () => {
    expect(normalizeTypeName('media/Transcripts')).toBe('transcript');
    expect(normalizeTypeName('companies')).toBe('company');
    expect(normalizeTypeName('analysis')).toBe('analysis');
    expect(normalizeTypeName('address')).toBe('address');
  });

  test('without a pack: normalized names and -suffix joins, each with its rule', () => {
    const map = collapseTypes(['transcript', 'media/transcript', 'audio-transcript', 'adversary-profile', 'notes'], null);
    expect(Object.fromEntries(map)).toEqual({
      'transcript': { group: 'transcript', via: 'exact' },
      'media/transcript': { group: 'transcript', via: 'normalized' },
      'audio-transcript': { group: 'transcript', via: 'suffix' },
      'adversary-profile': { group: 'adversary-profile', via: 'exact' },
      'notes': { group: 'note', via: 'normalized' },
    });
  });

  test('the active pack decides first: declared types stay, aliases join their canonical type', () => {
    const pack = { page_types: [
      { name: 'person', path_prefixes: ['people/'], aliases: ['researcher'] },
      { name: 'meeting-note', path_prefixes: ['meetings/'] },
      { name: 'note', path_prefixes: ['notes/'] },
    ] };
    const map = collapseTypes(['researcher', 'person', 'meeting-note', 'Researchers', 'quick-note'], pack);
    expect(map.get('researcher')).toEqual({ group: 'person', via: 'pack_alias' });
    expect(map.get('person')).toEqual({ group: 'person', via: 'exact' });
    expect(map.get('meeting-note')).toEqual({ group: 'meeting-note', via: 'exact' });
    expect(map.get('Researchers')).toEqual({ group: 'person', via: 'normalized' });
    expect(map.get('quick-note')).toEqual({ group: 'note', via: 'suffix' });
  });

  test('groupPageCounts sorts deterministically and reports members only when collapsing', () => {
    const counts = {
      bySourceType: [
        { source_id: 'b', type: 'note', pages: 1 },
        { source_id: 'a', type: 'note', pages: 2 },
        { source_id: 'a', type: 'person', pages: 5 },
      ],
      byTypeGroup: [],
      total: { pages: 8, distinct_slugs: 7 },
    };
    const r = groupPageCounts(counts, { by: ['source', 'type'], since: null, collapse: null });
    expect(r.groups).toEqual([
      { source_id: 'a', type: 'person', pages: 5 },
      { source_id: 'a', type: 'note', pages: 2 },
      { source_id: 'b', type: 'note', pages: 1 },
    ]);
    expect(r).toMatchObject({ total_pages: 8, distinct_slugs: 7, collapse_aliases: false });
    expect(groupPageCounts(counts, { by: [], since: null, collapse: null }).groups).toEqual([]);
  });
});

describe('CLI renderers', () => {
  test('find rows are tab-separated with escaped cells', () => {
    const out = formatFindPages({ complete: true, total: 1, limit: 50, pages: [
      { slug: 'people/alice-example', source_id: 'source-a', type: 'person', title: 'Alice\tExample', updated_at: '2026-10-01T00:00:00.000000Z' },
    ] });
    expect(out).toBe('people/alice-example\tsource-a\tperson\t2026-10-01\tAlice\\tExample\n');
    expect(formatFindPages({ complete: true, total: 0, limit: 50, pages: [] })).toBe('No pages found.\n');
  });

  test('grouped stats print totals, a header and collapsed members', () => {
    const out = formatStatsBy({
      schema_version: 1, by: ['type'], since: null, collapse_aliases: true, total_pages: 3, distinct_slugs: 2,
      groups: [{ type: 'transcript', pages: 3, distinct_slugs: 2, member_types: [
        { type: 'transcript', pages: 2, via: 'exact' }, { type: 'media/transcript', pages: 1, via: 'normalized' },
      ] }],
    });
    expect(out).toBe('Pages:     3 (2 distinct slugs)\n\ntype\tpages\tdistinct_slugs\ntranscript\t3\t2\n  = transcript (2, exact), media/transcript (1, normalized)\n');
  });
});
