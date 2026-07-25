import { describe, expect, test } from 'bun:test';
import { normalizeChineseQuery } from '../../src/core/search/query-normalize-zh.ts';

describe('normalizeChineseQuery', () => {
  test('normalizes full-width characters and project vocabulary', () => {
    const view = normalizeChineseQuery('Ａ项目的责任人和延误风险');
    expect(view.normalized).toBe('A项目的负责人和延期风险');
    expect(view.lexicalQueries).toContain('A项目的负责人和延期风险');
    expect(view.lexicalQueries).toContain('A项目的责任人和延误风险');
  });

  test('extracts relative time into an explicit local calendar window', () => {
    const view = normalizeChineseQuery(
      '上周项目进度',
      new Date(2026, 6, 25, 12, 0, 0),
    );
    expect(view.normalized).toBe('项目进展');
    expect(view.since).toEqual(new Date(2026, 6, 13));
    expect(view.until).toEqual(new Date(2026, 6, 20));
  });

  test('leaves non-Chinese queries as a single normalized variant', () => {
    expect(normalizeChineseQuery('  Project   status  ')).toEqual({
      normalized: 'Project status',
      lexicalQueries: ['Project status'],
    });
  });
});
