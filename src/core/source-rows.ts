/**
 * Small helpers for call sites that read `sources` through a typed engine member (listAllSources, getSource,
 * listSourceRecords, ...) where they once ran their own SQL, so the rows they use stay the rows the SQL returned.
 */

/** Rows in `ORDER BY id` order. Source ids are lowercase ASCII (SOURCE_ID_RE), so byte order is the SQL order. */
export function sortSourcesById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * `config->>'key'` for a source config as a member returns it: the text of a top-level key, or null when the config
 * is not an object or has no such key. A string stays itself; a number or boolean becomes its JSON text.
 */
export function sourceConfigText(config: unknown, key: string): string | null {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}
