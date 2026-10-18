/**
 * One guard for the bind-placeholder bug class (#6659, the CJK keyword count):
 * Postgres and PGLite refuse a statement that binds a parameter it never
 * references (42P18 "could not determine data type", or 08P01 "bind message
 * supplies N parameters"). Each exported `{ sql, params }` builder runs over
 * its platform/option matrix, and the `$n` placeholders its SQL references
 * must be exactly `1..params.length`.
 */
import { describe, expect, test } from 'bun:test';
import type { SearchOpts } from '../src/core/types.ts';
import { fileClaimCandidatesQuery } from '../src/core/persistence/file-claims.ts';
import { buildKeywordCountStatement, buildKeywordPagesStatement } from '../src/core/search/keyword-statement.ts';

function referenced(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)(?!\d)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
}
function expectEveryBindReferenced(statement: { sql: string; params: unknown[] } | null): void {
  expect(statement).not.toBeNull();
  expect(referenced(statement!.sql)).toEqual(statement!.params.map((_, i) => i + 1));
}

describe('file-claim census', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    test(`${platform}: every bound placeholder is referenced`, () => {
      expectEveryBindReferenced(fileClaimCandidatesQuery({
        sourceId: 'default', pageId: 1, afterId: 0, maxId: 10, fileName: 'example.md', uriNames: ['example.md'],
      }, platform));
    });
  }
});

describe('keyword statements', () => {
  const filterSets: Array<[string, SearchOpts | undefined]> = [
    ['no options', undefined],
    ['types + source', { types: ['meeting', 'note'], sourceId: 'default' }],
    ['every filter', {
      detail: 'low', language: 'typescript', symbolKind: 'function', type: 'note', types: ['note'], exclude_slugs: ['a/b'],
      afterDate: '2026-01-01', beforeDate: '2026-12-31', sourceIds: ['default', 'other'],
    }],
  ];
  for (const query of ['quasar budget', '혈당', '혈당 관리']) {
    for (const [label, opts] of filterSets) {
      test(`count: ${JSON.stringify(query)} with ${label}`, () => {
        expectEveryBindReferenced(buildKeywordCountStatement(query, opts));
      });
      test(`pages: ${JSON.stringify(query)} with ${label}, first page and after a cursor`, () => {
        expectEveryBindReferenced(buildKeywordPagesStatement(query, opts, { limit: 10 }));
        expectEveryBindReferenced(buildKeywordPagesStatement(query, opts, { limit: 10, offset: 5, after: { score: 0.5, page_id: 7 } }));
      });
    }
  }
});
