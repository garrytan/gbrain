import { test, expect, describe } from 'bun:test';
import {
  ACCESS_TIERS,
  ACCESS_TIER_DEFAULT,
  OP_TIER_DEFAULT_REQUIRED,
  isAccessTier,
  tierImplies,
  parseAccessTier,
  resolveStoredAccessTier,
  tierAllowsSlug,
  filterResponseByTier,
  DEFAULT_TIER_PREFIXES,
  InvalidAccessTierError,
  type AccessTier,
} from '../src/core/access-tier.ts';

// ---------------------------------------------------------------------------
// Runtime MCP access control: AccessTier primitive tests.
// Mirrors the shape of test/scope.test.ts so the two trust primitives
// stay legible side-by-side.
// ---------------------------------------------------------------------------

describe('isAccessTier — recognises only the four canonical tiers', () => {
  for (const t of ACCESS_TIERS) {
    test(`accepts ${t}`, () => {
      expect(isAccessTier(t)).toBe(true);
    });
  }
  test('rejects empty string', () => {
    expect(isAccessTier('')).toBe(false);
  });
  test('rejects unknown tier', () => {
    expect(isAccessTier('Admin')).toBe(false);
  });
  test('rejects non-string', () => {
    expect(isAccessTier(undefined)).toBe(false);
    expect(isAccessTier(null)).toBe(false);
    expect(isAccessTier(42)).toBe(false);
  });
  test('case sensitive — full vs Full', () => {
    // ACCESS_POLICY.md uses TitleCase; lowercase is a typo, not a tier.
    expect(isAccessTier('full')).toBe(false);
  });
  // Regression: a prior implementation used `value in RANK` (object
  // literal `{None,Family,Work,Full}`). The `in` operator walks the
  // prototype chain, so 'toString', 'hasOwnProperty', etc. all
  // returned true and registered as valid tiers. Set membership
  // closes that gap.
  test('rejects Object.prototype keys (prototype-pollution regression)', () => {
    for (const proto of ['toString', 'hasOwnProperty', 'constructor', 'valueOf', '__proto__', 'isPrototypeOf']) {
      expect(isAccessTier(proto)).toBe(false);
    }
  });
});

describe('tierImplies — Full subsumes Work subsumes Family subsumes None', () => {
  test('Full satisfies every tier', () => {
    for (const required of ACCESS_TIERS) {
      expect(tierImplies('Full', required)).toBe(true);
    }
  });
  test('Work satisfies Work, Family, None — but not Full', () => {
    expect(tierImplies('Work', 'Full')).toBe(false);
    expect(tierImplies('Work', 'Work')).toBe(true);
    expect(tierImplies('Work', 'Family')).toBe(true);
    expect(tierImplies('Work', 'None')).toBe(true);
  });
  test('Family satisfies Family + None only', () => {
    expect(tierImplies('Family', 'Full')).toBe(false);
    expect(tierImplies('Family', 'Work')).toBe(false);
    expect(tierImplies('Family', 'Family')).toBe(true);
    expect(tierImplies('Family', 'None')).toBe(true);
  });
  test('None satisfies only None', () => {
    expect(tierImplies('None', 'Full')).toBe(false);
    expect(tierImplies('None', 'Work')).toBe(false);
    expect(tierImplies('None', 'Family')).toBe(false);
    expect(tierImplies('None', 'None')).toBe(true);
  });
  test('rejects unknown tier on either side (fail-closed)', () => {
    expect(tierImplies('bogus' as AccessTier, 'None')).toBe(false);
    expect(tierImplies('Full', 'bogus' as AccessTier)).toBe(false);
  });
});

describe('parseAccessTier — typo-loud at the registration boundary', () => {
  test('returns undefined for null/undefined/empty', () => {
    expect(parseAccessTier(null)).toBeUndefined();
    expect(parseAccessTier(undefined)).toBeUndefined();
    expect(parseAccessTier('')).toBeUndefined();
    expect(parseAccessTier('   ')).toBeUndefined();
  });
  test('parses each canonical tier', () => {
    for (const t of ACCESS_TIERS) {
      expect(parseAccessTier(t)).toBe(t);
    }
  });
  test('trims whitespace', () => {
    expect(parseAccessTier('  Work ')).toBe('Work');
  });
  test('throws InvalidAccessTierError on a non-empty unknown tier', () => {
    expect(() => parseAccessTier('admin')).toThrow(InvalidAccessTierError);
    expect(() => parseAccessTier('full')).toThrow(InvalidAccessTierError);
    expect(() => parseAccessTier('SUPER')).toThrow(InvalidAccessTierError);
  });
});

describe('ACCESS_TIER_DEFAULT', () => {
  test('is Full to preserve the pre-v45 grant for legacy oauth_clients rows', () => {
    expect(ACCESS_TIER_DEFAULT).toBe('Full');
  });
  test('OP_TIER_DEFAULT_REQUIRED is Full so unannotated ops fail closed for non-Full callers', () => {
    expect(OP_TIER_DEFAULT_REQUIRED).toBe('Full');
  });
});

describe('resolveStoredAccessTier — fail-closed read-side coercion', () => {
  test('NULL preserves pre-v45 grant (Full)', () => {
    expect(resolveStoredAccessTier(null)).toBe('Full');
    expect(resolveStoredAccessTier(undefined)).toBe('Full');
  });
  test('empty string preserves pre-v45 grant (Full)', () => {
    expect(resolveStoredAccessTier('')).toBe('Full');
    expect(resolveStoredAccessTier('   ')).toBe('Full');
  });
  test('valid tier passes through', () => {
    for (const t of ACCESS_TIERS) {
      expect(resolveStoredAccessTier(t)).toBe(t);
    }
  });
  test('trims whitespace on a valid value', () => {
    expect(resolveStoredAccessTier('  Work  ')).toBe('Work');
  });
  test('unrecognised string falls CLOSED to None (corrupt-DB defense)', () => {
    expect(resolveStoredAccessTier('admin')).toBe('None');
    expect(resolveStoredAccessTier('SUPER')).toBe('None');
    // Prototype-pollution candidates resolve to None too.
    expect(resolveStoredAccessTier('toString')).toBe('None');
  });
  test('non-string non-null DB value falls closed to None', () => {
    expect(resolveStoredAccessTier(42)).toBe('None');
    expect(resolveStoredAccessTier({})).toBe('None');
  });
});

describe('tierAllowsSlug — slug-prefix visibility', () => {
  test('Full sees everything via wildcard', () => {
    expect(tierAllowsSlug('personal/diary', 'Full')).toBe(true);
    expect(tierAllowsSlug('soul/identity', 'Full')).toBe(true);
    expect(tierAllowsSlug('anything', 'Full')).toBe(true);
  });
  test('Work sees brain pages but not personal', () => {
    expect(tierAllowsSlug('people/alice', 'Work')).toBe(true);
    expect(tierAllowsSlug('companies/acme', 'Work')).toBe(true);
    expect(tierAllowsSlug('wiki/projects/foo', 'Work')).toBe(true);
    expect(tierAllowsSlug('personal/diary', 'Work')).toBe(false);
    expect(tierAllowsSlug('soul/identity', 'Work')).toBe(false);
  });
  test('Family sees logistics only', () => {
    expect(tierAllowsSlug('logistics/calendar', 'Family')).toBe(true);
    expect(tierAllowsSlug('meetings/2026-q1', 'Family')).toBe(true);
    expect(tierAllowsSlug('people/alice', 'Family')).toBe(false);
    expect(tierAllowsSlug('personal/diary', 'Family')).toBe(false);
  });
  test('None sees nothing', () => {
    for (const slug of ['anything', 'people/alice', 'logistics/x', '']) {
      expect(tierAllowsSlug(slug, 'None')).toBe(false);
    }
  });
  test('non-string slug rejected', () => {
    expect(tierAllowsSlug('', 'Full')).toBe(false);
    expect(tierAllowsSlug(null as unknown as string, 'Full')).toBe(false);
  });
});

describe('filterResponseByTier — read-path response filtering', () => {
  test('Full tier passes results through unchanged', async () => {
    const list = [{ slug: 'people/alice' }, { slug: 'personal/diary' }];
    expect(await filterResponseByTier('list_pages', list, { tier: 'Full' })).toBe(list);
  });
  test('undefined tier (local CLI / stdio) passes through unchanged', async () => {
    const list = [{ slug: 'people/alice' }, { slug: 'personal/diary' }];
    expect(await filterResponseByTier('list_pages', list, {})).toBe(list);
  });
  test('Work tier filters list_pages by slug prefix', async () => {
    const list = [
      { slug: 'people/alice', title: 'Alice' },
      { slug: 'personal/diary', title: 'Diary' },
      { slug: 'companies/acme', title: 'Acme' },
    ];
    const filtered = await filterResponseByTier('list_pages', list, { tier: 'Work' });
    expect(Array.isArray(filtered)).toBe(true);
    expect((filtered as Array<{ slug: string }>).map(r => r.slug)).toEqual(['people/alice', 'companies/acme']);
  });
  test('Family tier filters list_pages to logistics only', async () => {
    const list = [
      { slug: 'people/alice' },
      { slug: 'logistics/calendar' },
      { slug: 'meetings/q1' },
    ];
    const filtered = await filterResponseByTier('list_pages', list, { tier: 'Family' });
    expect((filtered as Array<{ slug: string }>).map(r => r.slug)).toEqual(['logistics/calendar', 'meetings/q1']);
  });
  test('None tier filters everything out', async () => {
    const list = [{ slug: 'people/alice' }, { slug: 'logistics/x' }];
    expect(await filterResponseByTier('list_pages', list, { tier: 'None' })).toEqual([]);
  });
  test('get_page throws OperationError(page_not_found) when out of tier visibility', async () => {
    const page = { slug: 'personal/diary', title: 'Diary', content: 'secret' };
    // Throws OperationError so the wire envelope is byte-identical to a
    // real engine not-found and a Work-tier caller cannot probe slug
    // existence by status code.
    await expect(
      filterResponseByTier('get_page', page, { tier: 'Work' }),
    ).rejects.toMatchObject({ name: 'OperationError', code: 'page_not_found' });
  });
  test('get_page passes visible page through unchanged', async () => {
    const page = { slug: 'people/alice', title: 'Alice' };
    expect(await filterResponseByTier('get_page', page, { tier: 'Work' })).toBe(page);
  });
  test('get_page ambiguous_slug — candidates filtered by tier; empty after filter throws not-found', async () => {
    // Multiple candidates with mixed visibility for Work: only the
    // visible ones survive; if none are visible, the filter throws
    // page_not_found rather than leaking the existence of personal slugs.
    const ambiguousMixed = {
      error: 'ambiguous_slug',
      candidates: ['people/alice', 'personal/alice-diary', 'companies/acme'],
    };
    const filtered = await filterResponseByTier('get_page', ambiguousMixed, { tier: 'Work' });
    expect(filtered).toEqual({
      error: 'ambiguous_slug',
      candidates: ['people/alice', 'companies/acme'],
    });

    const ambiguousAllPersonal = {
      error: 'ambiguous_slug',
      candidates: ['personal/a', 'personal/b'],
    };
    await expect(
      filterResponseByTier('get_page', ambiguousAllPersonal, { tier: 'Work' }),
    ).rejects.toMatchObject({ name: 'OperationError', code: 'page_not_found' });
  });
  test('find_orphans wrapper — inner orphans array filtered, totals recomputed', async () => {
    // Real shape from src/commands/orphans.ts findOrphans():
    // { orphans, total_orphans, total_linkable, total_pages, excluded }.
    // A prior implementation only handled top-level arrays so the whole
    // wrapper passed through unchanged — Work tier saw every personal/
    // orphan slug. Regression test for that defect.
    const wrapper = {
      orphans: [
        { slug: 'people/alice', title: 'Alice', domain: null },
        { slug: 'personal/diary', title: 'Diary', domain: null },
        { slug: 'companies/acme', title: 'Acme', domain: null },
      ],
      total_orphans: 3,
      total_linkable: 5,
      total_pages: 100,
      excluded: 2,
    };
    const filtered = await filterResponseByTier('find_orphans', wrapper, { tier: 'Work' });
    expect(filtered).toEqual({
      orphans: [
        { slug: 'people/alice', title: 'Alice', domain: null },
        { slug: 'companies/acme', title: 'Acme', domain: null },
      ],
      total_orphans: 2,
      total_linkable: 5,
      total_pages: 100,
      excluded: 3, // 2 pre-existing + 1 newly hidden
    });
  });
  test('resolve_slugs string[] — bare slugs filtered by tier prefix', async () => {
    // Real shape from src/core/operations.ts resolve_slugs handler:
    // ctx.engine.resolveSlugs() returns Promise<string[]>. Prior filter
    // looked for `row.slug` on object rows and silently no-op'd on bare
    // strings, leaking slug existence to Work-tier callers via
    // resolve_slugs("personal").
    const slugs = ['people/alice', 'personal/diary', 'companies/acme', 'soul/identity'];
    const filtered = await filterResponseByTier('resolve_slugs', slugs, { tier: 'Work' });
    expect(filtered).toEqual(['people/alice', 'companies/acme']);
  });
  test('resolve_slugs string[] — None tier strips everything', async () => {
    const slugs = ['people/alice', 'logistics/x'];
    expect(await filterResponseByTier('resolve_slugs', slugs, { tier: 'None' })).toEqual([]);
  });
  test('search returns SearchResult[] (page-array) — Work tier strips personal hits', async () => {
    // Real shape: hybridSearch returns SearchResult[] each with a `slug`
    // field. Confirms the page-array branch handles search/query results.
    const results = [
      { slug: 'people/alice', score: 0.9, chunk_text: 'Alice...' },
      { slug: 'personal/diary', score: 0.8, chunk_text: 'secret diary entry' },
    ];
    const filtered = await filterResponseByTier('search', results, { tier: 'Work' });
    expect((filtered as Array<{ slug: string }>).map(r => r.slug)).toEqual(['people/alice']);
  });
  test('non-page-shape ops (traverse_graph etc.) pass through unchanged', async () => {
    const graph = { nodes: [{ slug: 'people/alice' }], edges: [] };
    expect(await filterResponseByTier('traverse_graph', graph, { tier: 'Family' })).toBe(graph);
  });
  test('mutating ops (put_page, sync_brain) pass through unchanged for any tier', async () => {
    const writeResult = { status: 'ok', slug: 'personal/diary' };
    expect(await filterResponseByTier('put_page', writeResult, { tier: 'Work' })).toBe(writeResult);
    expect(await filterResponseByTier('sync_brain', writeResult, { tier: 'None' })).toBe(writeResult);
  });
  test('uses default prefix map when not overridden', async () => {
    const list = [{ slug: 'people/alice' }];
    const filteredDefault = await filterResponseByTier('list_pages', list, { tier: 'Family' });
    const filteredCustom = await filterResponseByTier('list_pages', list, {
      tier: 'Family',
      prefixes: { ...DEFAULT_TIER_PREFIXES, Family: ['people/'] },
    });
    expect((filteredDefault as Array<unknown>).length).toBe(0);
    expect((filteredCustom as Array<unknown>).length).toBe(1);
  });
  test('page-array branch drops rows with missing or non-string slug (fail-closed)', async () => {
    // Defense against future ops returning mixed-shape rows. A row the
    // filter cannot inspect must be dropped, not passed through, for any
    // non-Full tier.
    const rows = [
      { slug: 'people/alice' },
      { slug: 12345 }, // non-string slug
      null,
      'bare-string',
      { /* no slug */ title: 'orphan' },
    ];
    const filtered = await filterResponseByTier('list_pages', rows, { tier: 'Work' });
    expect(filtered).toEqual([{ slug: 'people/alice' }]);
  });
});
