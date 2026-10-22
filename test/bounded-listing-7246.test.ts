/**
 * #7246: the shared bounded-listing helper (src/core/bounded-listing.ts and
 * its CLI half) that orphans uses and the sync status --detail bounding will
 * reuse. Protects the cursor contract: keyset pages never skip or repeat a
 * surviving row when rows are added or removed between pages, a foreign or
 * malformed cursor is refused, and the flag parser keeps --limit in the next
 * page's argv. Fails if the cursor degrades to an offset.
 */
import { describe, expect, test } from 'bun:test';
import { capRowList, decodeListingCursor, encodeListingCursor, pageSortedRows, topCounts } from '../src/core/bounded-listing.ts';
import { nextListingCommand, parseListingFlags } from '../src/core/bounded-listing-cli.ts';

const key = (row: { slug: string }) => [row.slug];
const rows = (...slugs: string[]) => slugs.map(slug => ({ slug }));

describe('bounded listing helper (#7246)', () => {
  test('a keyset page resumes after the last row even when rows change between pages', () => {
    const first = pageSortedRows(rows('d', 'b', 'a', 'c', 'e'), key, { limit: 2 }, 'k');
    expect(first.rows.map(r => r.slug)).toEqual(['a', 'b']);
    expect(first.complete).toBe(false);
    const second = pageSortedRows(rows('0', 'a', 'c', 'd', 'e', 'f'), key, { limit: 2, cursor: first.next_cursor! }, 'k');
    expect(second.rows.map(r => r.slug)).toEqual(['c', 'd']);
    const last = pageSortedRows(rows('0', 'a', 'c', 'd', 'e', 'f'), key, { limit: 2, cursor: second.next_cursor! }, 'k');
    expect(last.rows.map(r => r.slug)).toEqual(['e', 'f']);
    expect(last.complete).toBe(true);
    expect(last.next_cursor).toBeNull();
  });

  test('limit null returns every row; an exact-fit page is complete', () => {
    expect(pageSortedRows(rows('b', 'a'), key, { limit: null }, 'k')).toMatchObject({ returned: 2, limit: null, complete: true, next_cursor: null });
    expect(pageSortedRows(rows('b', 'a'), key, { limit: 2 }, 'k')).toMatchObject({ complete: true, next_cursor: null });
  });

  test('foreign and malformed cursors are refused', () => {
    expect(decodeListingCursor('k', encodeListingCursor('k', ['x', 'y']))).toEqual(['x', 'y']);
    expect(() => decodeListingCursor('other', encodeListingCursor('k', ['x']))).toThrow('different listing');
    expect(() => decodeListingCursor('k', 'not-a-cursor')).toThrow('not a listing cursor');
  });

  test('topCounts keeps the largest keys and counts the rest', () => {
    expect(topCounts(rows('a', 'a', 'b', 'c', 'c', 'c'), r => r.slug, 2)).toEqual({ counts: { c: 3, a: 2 }, other: 1 });
  });

  test('capRowList marks a capped row incomplete and leaves a short row untouched', () => {
    const row = { id: 1, items: [1, 2, 3] };
    expect(capRowList(row, 'items', 2) as unknown).toEqual({ id: 1, items: [1, 2], items_complete: false });
    expect(capRowList(row, 'items', 3)).toBe(row);
    expect(capRowList(row, 'items', null)).toBe(row);
  });

  test('parseListingFlags defaults to 100, keeps --limit for the next page and refuses --all with a limit', () => {
    expect(parseListingFlags(['--json'], 'gbrain x')).toEqual({ request: { limit: 100 }, rest: ['--json'] });
    const parsed = parseListingFlags(['--limit=5', '--cursor', 'abc', '--json'], 'gbrain x');
    expect(parsed).toEqual({ request: { limit: 5, cursor: 'abc' }, rest: ['--limit=5', '--json'] });
    expect(nextListingCommand(['gbrain', 'x', ...parsed.rest], { next_cursor: 'def' })).toEqual(['gbrain', 'x', '--limit=5', '--json', '--cursor', 'def']);
    expect(parseListingFlags(['--all'], 'gbrain x').request).toEqual({ limit: null });
    expect(() => parseListingFlags(['--all', '--limit', '3'], 'gbrain x')).toThrow('--all lists every row');
    expect(() => parseListingFlags(['--limit', '0'], 'gbrain x')).toThrow('--limit must be a positive integer');
    expect(() => parseListingFlags(['--cursor'], 'gbrain x')).toThrow('--cursor needs a value');
  });
});
