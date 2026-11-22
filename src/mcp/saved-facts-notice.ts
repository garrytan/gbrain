/** The saved-facts notice search and query print after their rows, on MCP and on the CLI (GST-2714). */

/**
 * Whole items after `head` while the block stays within `max` characters;
 * an item is never cut, so its provenance stays intact. The first item is
 * always shown, even alone over the ceiling. `more` counts the items left out.
 */
export function wholeItemsWithin(head: string, items: string[], sep: string, max: number): { text: string; more: number } {
  let text = head + items[0];
  let shown = 1;
  while (shown < items.length && text.length + sep.length + items[shown].length <= max) text += sep + items[shown++];
  return { text, more: items.length - shown };
}

export const SAVED_FACTS_NOTICE_MAX_CHARS = 1_500;

export type SavedFactNotice = { fact: string; entity_slug: string | null; valid_from: string; source: string; linked_from?: string; corrected_by?: number; quoted?: string; room_access?: { readable: unknown; reason?: string } };

/** The saved facts (remember) a search or query matched, as the block MCP and the CLI print after the rows; null when there are none. */
export function savedFactsNoticeBlock(savedFacts: SavedFactNotice[] | undefined): string | null {
  if (!savedFacts?.length) return null;
  const { text, more } = wholeItemsWithin('Saved facts (remember): about the entity this query names (newest first), then facts those point to, then matches for its words; recall returns more:\n',
    savedFacts.map(f => `- ${f.fact}${f.quoted ? '\n' : ''} [entity: ${f.entity_slug ?? 'none'}; saved ${String(f.valid_from).slice(0, 10)}; provenance: ${f.source}${f.linked_from ? `; named in a saved fact about ${f.linked_from}` : ''}${f.corrected_by ? '; corrected by a newer saved fact above' : ''}${f.room_access ? `; room: ${f.room_access.readable === true ? 'readable' : f.room_access.readable === false ? `not readable (${f.room_access.reason})` : `unknown (${f.room_access.reason})`}` : ''}]`),
    '\n', SAVED_FACTS_NOTICE_MAX_CHARS);
  return more ? `${text}\n(+${more} more; recall returns them)` : text;
}

/** The CLI's saved-facts text for search and query: printed after the rows, or on stderr under --json so stdout stays the row array. */
export function cliSavedFacts(meta: { saved_facts?: unknown } | null | undefined, json: boolean): string {
  const block = Array.isArray(meta?.saved_facts) ? savedFactsNoticeBlock(meta.saved_facts as SavedFactNotice[]) : null;
  if (!block) return '';
  if (!json) return block + '\n';
  process.stderr.write(block + '\n');
  return '';
}
