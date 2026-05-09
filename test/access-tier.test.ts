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
  test('Full tier passes results through unchanged', () => {
    const list = [{ slug: 'people/alice' }, { slug: 'personal/diary' }];
    expect(filterResponseByTier('list_pages', list, { tier: 'Full' })).toBe(list);
  });
  test('undefined tier (local CLI / stdio) passes through unchanged', () => {
    const list = [{ slug: 'people/alice' }, { slug: 'personal/diary' }];
    expect(filterResponseByTier('list_pages', list, {})).toBe(list);
  });
  test('Work tier filters list_pages by slug prefix', () => {
    const list = [
      { slug: 'people/alice', title: 'Alice' },
      { slug: 'personal/diary', title: 'Diary' },
      { slug: 'companies/acme', title: 'Acme' },
    ];
    const filtered = filterResponseByTier('list_pages', list, { tier: 'Work' });
    expect(Array.isArray(filtered)).toBe(true);
    expect((filtered as Array<{ slug: string }>).map(r => r.slug)).toEqual(['people/alice', 'companies/acme']);
  });
  test('Family tier filters list_pages to logistics only', () => {
    const list = [
      { slug: 'people/alice' },
      { slug: 'logistics/calendar' },
      { slug: 'meetings/q1' },
    ];
    const filtered = filterResponseByTier('list_pages', list, { tier: 'Family' });
    expect((filtered as Array<{ slug: string }>).map(r => r.slug)).toEqual(['logistics/calendar', 'meetings/q1']);
  });
  test('None tier filters everything out', () => {
    const list = [{ slug: 'people/alice' }, { slug: 'logistics/x' }];
    expect(filterResponseByTier('list_pages', list, { tier: 'None' })).toEqual([]);
  });
  test('get_page returns page_not_found shape when out of tier visibility', () => {
    const page = { slug: 'personal/diary', title: 'Diary', content: 'secret' };
    const filtered = filterResponseByTier('get_page', page, { tier: 'Work' });
    expect(filtered).toEqual({ error: 'page_not_found', message: 'Page not found: personal/diary' });
  });
  test('get_page passes visible page through unchanged', () => {
    const page = { slug: 'people/alice', title: 'Alice' };
    expect(filterResponseByTier('get_page', page, { tier: 'Work' })).toBe(page);
  });
  test('non-page-shape ops (traverse_graph etc.) pass through unchanged', () => {
    const graph = { nodes: [{ slug: 'people/alice' }], edges: [] };
    expect(filterResponseByTier('traverse_graph', graph, { tier: 'Family' })).toBe(graph);
  });
  test('uses default prefix map when not overridden', () => {
    const list = [{ slug: 'people/alice' }];
    const filteredDefault = filterResponseByTier('list_pages', list, { tier: 'Family' });
    const filteredCustom = filterResponseByTier('list_pages', list, {
      tier: 'Family',
      prefixes: { ...DEFAULT_TIER_PREFIXES, Family: ['people/'] },
    });
    expect((filteredDefault as Array<unknown>).length).toBe(0);
    expect((filteredCustom as Array<unknown>).length).toBe(1);
  });
});
