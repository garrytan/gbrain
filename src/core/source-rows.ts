/**
 * Small helpers for call sites that read `sources` through a typed engine member (listAllSources, getSource,
 * listSourceRecords, ...) where they once ran their own SQL, so the rows they use stay the rows the SQL returned.
 */
import type { BrainEngine, SourceRecordRow } from './engine.ts';

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

/**
 * Source rows with `config` exactly as the driver returns it, for call sites that read `config` with their own SQL
 * before. `listAllSources` parses a config stored as a JSON string; these rows keep the string, so a key read
 * (`sourceConfigText`) gives null for it, as `config->>'k'` did. Live rows only (`archived IS NOT TRUE`) unless
 * `includeArchived`; `default` first, then by id. A schema without `archived` gives every row.
 */
export async function sourceRecordsRawConfig(
  engine: Pick<BrainEngine, 'listSourceRecords'>,
  opts: { includeArchived?: boolean } = {},
): Promise<SourceRecordRow[]> {
  const rows = await engine.listSourceRecords();
  return opts.includeArchived === true ? rows : rows.filter(row => row.archived !== true);
}

/**
 * `SELECT id, incarnation, local_path, config, archived FROM sources WHERE id = ANY($1) ORDER BY id COLLATE "C"` through the
 * typed `readSourceState` member: one row per known id (archived ones included), in byte order of id.
 */
export async function readSourceStates(engine: Pick<BrainEngine, 'readSourceState'>, sourceIds: readonly string[]) {
  const rows = await Promise.all([...new Set(sourceIds)].map(async id => {
    const state = await engine.readSourceState(id);
    return state ? { id, ...state } : null;
  }));
  return sortSourcesById(rows.filter((row): row is NonNullable<typeof row> => row !== null));
}
