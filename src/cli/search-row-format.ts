/** One human line per `search` / `query` row; a saved-fact row is named by its fact id and entity, never a page slug (#8411). */
import type { SearchResult } from '../core/types.ts';
import { rowPreview } from '../core/search/transcript-quote.ts';
import { guestWarningLine } from '../core/guests/marker.ts';

type Row = SearchResult & { fact_id?: string; page_slug?: string; follow_up?: { args?: Record<string, string> } };

/** GBRA-504: a guest row is preceded by its warning line, rendered from the stamped guest fields. */
export function formatSearchRow(r: Row): string {
  return r.guest ? `${guestWarningLine(r.guest)}
${formatRow(r)}` : formatRow(r);
}

function formatRow(r: Row): string {
  const score = `[${r.score?.toFixed(4) || '?'}]`;
  const preview = rowPreview(r, 100);
  if (r.result_type !== 'fact') return `${score} ${r.slug} -- ${preview}${r.stale ? ' (stale)' : ''}`;
  const entity = r.page_slug ?? r.follow_up?.args?.entity;
  return `${score} fact:${r.fact_id}${entity ? ` ${entity}` : ''} -- ${preview.replace(/\s*\n\s*/g, ' ')}`;
}
