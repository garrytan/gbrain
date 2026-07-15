import { describe, test, expect } from 'bun:test';
import { sortNewestFirst } from '../src/core/sort-newest-first.ts';

describe('sortNewestFirst', () => {
  test('date-prefixed paths get sorted newest-first', () => {
    const input = [
      'meetings/2020-01-01-old.md',
      'meetings/2026-05-13-recent.md',
      'meetings/2024-03-15-middle.md',
    ];
    const out = sortNewestFirst([...input]);
    expect(out[0]).toBe('meetings/2026-05-13-recent.md');
    expect(out[1]).toBe('meetings/2024-03-15-middle.md');
    expect(out[2]).toBe('meetings/2020-01-01-old.md');
  });

  test('mixed prefixes produce deterministic descending order', () => {
    const input = [
      'concepts/a.md',
      'meetings/2026-05-13.md',
      'people/zoe.md',
      'daily/2026-05-12.md',
    ];
    const out = sortNewestFirst([...input]);
    // Pure lex descending — pin the exact order so the contract is locked.
    expect(out).toEqual([
      'people/zoe.md',
      'meetings/2026-05-13.md',
      'daily/2026-05-12.md',
      'concepts/a.md',
    ]);
  });

  test('empty input returns empty', () => {
    expect(sortNewestFirst([])).toEqual([]);
  });

  test('single element returns single element', () => {
    expect(sortNewestFirst(['only.md'])).toEqual(['only.md']);
  });

  test('mutates in place AND returns the same reference', () => {
    const arr = ['a.md', 'c.md', 'b.md'];
    const ret = sortNewestFirst(arr);
    expect(ret).toBe(arr); // same reference
    expect(arr).toEqual(['c.md', 'b.md', 'a.md']); // caller's view reflects the sort
  });
});
