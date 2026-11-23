/**
 * The long-page size preflight statement (search/evidence-delivery.ts selectLongPages): the character and byte length
 * of the stored body of each page in `ids` that the read scope serves. With `timeline`, a timeline that holds a
 * non-space character adds the separator and its own length; without it (detail `low`) only the compiled truth counts.
 * One read filter is bound after the id list, so the statement is built here as text rather than as fragments.
 */
import type { PageReadScope } from '../types.ts';
import { TIMELINE_SEPARATOR } from '../page-window/document.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { safeChunksFilter, requiresSafeChunks, servedTextProjectionFilter } from './safe-chunks.ts';

export interface LongPageSizeRow { id: number; chars: number; bytes: number }

export function longPageSizeStatement(ids: readonly number[], scope: PageReadScope, timeline: boolean): { text: string; params: unknown[] } {
  const params: unknown[] = [[...ids]];
  const filter = pageReadFilter('p', scope, params, true);
  const tl = timeline ? `CASE WHEN COALESCE(p.timeline, '') !~ '\\S' THEN 0 ELSE ${TIMELINE_SEPARATOR.length} + ` : null;
  return {
    text: `SELECT p.id, char_length(COALESCE(p.compiled_truth, ''))${tl ? ` + ${tl}char_length(p.timeline) END` : ''} AS chars,
              octet_length(COALESCE(p.compiled_truth, ''))${tl ? ` + ${tl}octet_length(p.timeline) END` : ''} AS bytes FROM pages p
        WHERE p.id = ANY($1::int[]) AND ${filter} AND ${servedTextProjectionFilter('p')}${requiresSafeChunks(scope) ? ` AND ${safeChunksFilter('p')}` : ''}`,
    params,
  };
}
