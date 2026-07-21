import { describe, test, expect } from 'bun:test';
import {
  LIFECYCLE_KEY,
  LIFECYCLE_HIDE_VALUES,
  LIFECYCLE_FILTER_FRAGMENT,
  lifecycleFilterFragment,
  isRetired,
  retiredStatus,
  filterOutRetired,
} from '../src/core/lifecycle.ts';
import { buildVisibilityClause } from '../src/core/search/sql-ranking.ts';

describe('lifecycle marker (retires / hides from search)', () => {
  test('LIFECYCLE_KEY is the plain `status` field', () => {
    expect(LIFECYCLE_KEY).toBe('status');
  });

  test('hide values are the unambiguous "no longer current" set', () => {
    expect([...LIFECYCLE_HIDE_VALUES].sort()).toEqual(
      ['deprecated', 'obsolete', 'retired', 'superseded'],
    );
  });

  test('isRetired: true only for a hide value (case/space-insensitive)', () => {
    expect(isRetired({ status: 'superseded' })).toBe(true);
    expect(isRetired({ status: 'Superseded' })).toBe(true);
    expect(isRetired({ status: '  DEPRECATED  ' })).toBe(true);
    expect(isRetired({ status: 'retired' })).toBe(true);
    expect(isRetired({ status: 'obsolete' })).toBe(true);
  });

  test('isRetired: false for non-retire statuses and absent/odd values', () => {
    // The whole point: everyday `status` values stay searchable.
    expect(isRetired({ status: 'active' })).toBe(false);
    expect(isRetired({ status: 'draft' })).toBe(false);
    expect(isRetired({ status: 'done' })).toBe(false);
    expect(isRetired({ status: 'in-progress' })).toBe(false);
    expect(isRetired({})).toBe(false);
    expect(isRetired(null)).toBe(false);
    expect(isRetired(undefined)).toBe(false);
    expect(isRetired({ status: null })).toBe(false);
    // Non-string status coerces to a non-matching value, never hides.
    expect(isRetired({ status: { superseded: true } })).toBe(false);
    expect(isRetired({ status: ['superseded'] })).toBe(false);
  });

  test('retiredStatus returns the normalized matched value or null', () => {
    expect(retiredStatus({ status: 'SUPERSEDED' })).toBe('superseded');
    expect(retiredStatus({ status: 'active' })).toBeNull();
    expect(retiredStatus(null)).toBeNull();
  });

  test('filterOutRetired drops only retired pages', () => {
    const pages = [
      { slug: 'a', frontmatter: { status: 'active' } },
      { slug: 'b', frontmatter: { status: 'superseded' } },
      { slug: 'c', frontmatter: null },
      { slug: 'd', frontmatter: {} },
      { slug: 'e', frontmatter: { status: 'deprecated' } },
    ];
    expect(filterOutRetired(pages).map((p) => p.slug)).toEqual(['a', 'c', 'd']);
  });

  test('LIFECYCLE_FILTER_FRAGMENT is a negated membership check on p', () => {
    expect(LIFECYCLE_FILTER_FRAGMENT).toContain('p.frontmatter');
    expect(LIFECYCLE_FILTER_FRAGMENT).toContain("->> 'status'");
    expect(LIFECYCLE_FILTER_FRAGMENT.startsWith('NOT (')).toBe(true);
    for (const v of LIFECYCLE_HIDE_VALUES) {
      expect(LIFECYCLE_FILTER_FRAGMENT).toContain(`'${v}'`);
    }
  });

  test('lifecycleFilterFragment(alias) parameterizes the page alias; constant is the p-instance', () => {
    expect(lifecycleFilterFragment('p')).toBe(LIFECYCLE_FILTER_FRAGMENT);
    expect(lifecycleFilterFragment('xx')).toContain('xx.frontmatter');
    expect(lifecycleFilterFragment('xx')).toContain("->> 'status'");
  });
});

describe('buildVisibilityClause wires in the lifecycle filter', () => {
  test('the composed clause keeps soft-delete + archive + quarantine + lifecycle', () => {
    const clause = buildVisibilityClause('p', 's');
    expect(clause).toContain('p.deleted_at IS NULL');
    expect(clause).toContain('NOT s.archived');
    expect(clause).toContain("? 'quarantine'");
    // the new arm
    expect(clause).toContain("->> 'status'");
    expect(clause).toContain("'superseded'");
  });

  test('alias is threaded through to the lifecycle arm', () => {
    const clause = buildVisibilityClause('page', 'src');
    expect(clause).toContain("page.frontmatter ->> 'status'");
  });
});
