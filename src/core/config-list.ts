/**
 * config-list.ts — the one parser for list-valued config keys.
 *
 * `cycle.conversation_facts_backfill.exclude_sources` (#7043) and
 * `transcripts.hermes.exclude_sources` (#8901) accept the same two spellings:
 * a JSON array of strings, or a comma-separated list (also when the list
 * itself is a JSON-quoted string: `"a,b"` lists `a` and `b`, never `"a` and
 * `b"`). The comma split (`splitSourceList`) is shared by both keys and the
 * `--exclude-source` flag. `parseSourceList` is the lenient reader the
 * backfill key uses (a JSON value that is neither an array nor a string lists
 * nothing); the Hermes key layers shape refusal on top in
 * `parseHermesExcludeConfig`, which shares only the split.
 */

/** A comma-separated list → trimmed, non-empty items. */
export function splitSourceList(text: string): string[] {
  return text.split(',').map((id) => id.trim()).filter(Boolean);
}

/** A JSON array of strings or a comma-separated list → trimmed, non-empty items; anything else → []. */
export function parseSourceList(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim());
    if (typeof parsed === 'string') return splitSourceList(parsed);
    return [];
  } catch { /* a comma-separated list */ }
  return splitSourceList(raw);
}
