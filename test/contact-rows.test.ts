/**
 * #8109: the pure contact-row dedupe. One row per (type, value), newest
 * activity date kept; no distinct value is ever dropped.
 */
import { describe, expect, test } from 'bun:test';
import { dedupeContactRows, dedupeFrontmatterContacts } from '../src/core/contact-rows.ts';

const phone = (value: string, last_used: unknown, extra: Record<string, unknown> = {}) => ({ type: 'phone', value, last_used, ...extra });

describe('#8109 dedupeContactRows', () => {
  test('a value written three times collapses to one row with the newest last_used, in first-seen order', () => {
    const list = [phone('+15550100', '2026-10-01'), { type: 'email', value: 'alice@example.com', last_used: '2026-09-01' },
      phone('+15550100', '2026-10-30'), phone('+15550100', '2026-10-15'), { type: 'email', value: 'alice@example.com', last_used: '2026-09-02' }];
    expect(dedupeContactRows(list)).toEqual({
      rows: [phone('+15550100', '2026-10-30'), { type: 'email', value: 'alice@example.com', last_used: '2026-09-02' }], removed: 3, kept_conflicting: 0 });
  });

  test('keys compare type case-insensitively and trimmed; distinct spellings of a value stay distinct rows', () => {
    const list = [phone('+15550100', '2026-10-01'), { type: ' Phone ', value: '+15550100 ', last_used: '2026-10-02' }, phone('555-0100', '2026-10-03'), phone('+1 555 0100', '2026-10-04')];
    const out = dedupeContactRows(list)!;
    expect(out.removed).toBe(1);
    expect(out.rows.map(row => (row as { value: string }).value)).toEqual(['+15550100', '555-0100', '+1 555 0100']);
    expect((out.rows[0] as { last_used: string }).last_used).toBe('2026-10-02');
  });

  test('a field present on one row only is kept; Date objects and timestamps compare as instants', () => {
    const out = dedupeContactRows([phone('+15550100', new Date('2026-10-01T00:00:00Z')), phone('+15550100', new Date('2026-10-05T00:00:00Z'), { label: 'mobile' })])!;
    expect(out.rows).toEqual([{ type: 'phone', value: '+15550100', last_used: new Date('2026-10-05T00:00:00Z'), label: 'mobile' }]);
  });

  test('a conflicting non-date field keeps every distinct row and drops only exact copies', () => {
    const list = [phone('+15550100', '2026-10-01', { label: 'mobile' }), phone('+15550100', '2026-10-01', { label: 'work' }), phone('+15550100', '2026-10-01', { label: 'mobile' })];
    expect(dedupeContactRows(list)).toEqual({ rows: list.slice(0, 2), removed: 1, kept_conflicting: 1 });
    // An activity date that is not a date cannot be ordered: the rows are kept apart, exact copies still go.
    expect(dedupeContactRows([phone('+15550100', 'yesterday'), phone('+15550100', '2026-10-01'), phone('+15550100', 'yesterday')])!.rows).toHaveLength(2);
  });

  test('non-row entries, rows without a type or value, and lists with nothing to merge are left alone', () => {
    expect(dedupeContactRows(['alice-example', 'alice-example'])).toBeNull();
    expect(dedupeContactRows([{ value: '+15550100' }, { value: '+15550100' }])).toBeNull();
    expect(dedupeContactRows([phone('+15550100', '2026-10-01'), phone('+15550101', '2026-10-01')])).toBeNull();
    expect(dedupeContactRows('not a list')).toBeNull();
    const mixed = dedupeContactRows(['alice-example', phone('+15550100', '2026-10-01'), 'alice-example', phone('+15550100', '2026-10-02')])!;
    expect(mixed.rows).toEqual(['alice-example', phone('+15550100', '2026-10-02'), 'alice-example']);
  });

  test('dedupeFrontmatterContacts touches only the contacts key', () => {
    expect(dedupeFrontmatterContacts({ phones: ['+15550100', '+15550100'] })).toBeNull();
    expect(dedupeFrontmatterContacts(null)).toBeNull();
    const out = dedupeFrontmatterContacts({ company: 'acme-example', contacts: [phone('+15550100', '2026-10-01'), phone('+15550100', '2026-10-02')] })!;
    expect(out.frontmatter).toEqual({ company: 'acme-example', contacts: [phone('+15550100', '2026-10-02')] });
    expect(out.dedupe.removed).toBe(1);
  });
});
