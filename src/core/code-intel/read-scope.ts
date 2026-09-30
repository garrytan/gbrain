import type { PageReadScope } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { currentTextProjectionFilter, requiresSafeChunks, safeChunksFilter } from '../search/safe-chunks.ts';

export interface CodeReadScope extends PageReadScope {
  allSources?: boolean;
}

export function codeReadFilter(params: unknown[], scope: CodeReadScope): string {
  const policy = scope.allSources && scope.sourceIds === undefined ? { ...scope, sourceId: undefined } : scope;
  return [
    pageReadFilter('p', policy, params, true),
    scope.sourceIds?.length === 0 ? 'FALSE' : 'TRUE',
    currentTextProjectionFilter('p'),
    ...(requiresSafeChunks(scope) ? [safeChunksFilter('p')] : []),
  ].join(' AND ');
}

export function currentCodeEdgeFilter(edgeAlias: string, resolved: boolean): string {
  const endpoint = (column: string) => `EXISTS (
    SELECT 1 FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
    WHERE cc.id=${edgeAlias}.${column} AND ${codeReadFilter([], {})}
  )`;
  return `${endpoint('from_chunk_id')}${resolved ? ` AND ${endpoint('to_chunk_id')}` : ''}`;
}
