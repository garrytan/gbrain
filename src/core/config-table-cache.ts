/**
 * Whole-config-table reads that re-send the table only when it changed.
 *
 * `getAllConfig()` runs once per MCP request, CLI startup and publication
 * (config-snapshot.ts). On a hosted brain the table is tens of kilobytes,
 * mostly a few large JSON values, so each read is that much database egress.
 * The engine runs one statement that always returns the table's content hash
 * (a row with a NULL key) and returns the rows only when that hash differs
 * from the one passed in. Same single round trip as a plain read; exact
 * freshness, because any write changes the hash, so a `gbrain config set`
 * from another process is seen by the next read, as before.
 */

/** A row of the engine's statement: `key === null` carries the table hash in `value`. */
export interface ConfigTableRow { key: string | null; value: string }

interface CachedTable { hash: string; rows: Record<string, string> }

/** Keyed by engine object; a transaction clone gets its own entry (and sees its own writes). */
const tables = new WeakMap<object, CachedTable>();

export async function readConfigTableCached(
  owner: object,
  run: (knownHash: string | null) => Promise<ConfigTableRow[]>,
): Promise<Record<string, string>> {
  const cached = tables.get(owner);
  const result = await run(cached?.hash ?? null);
  const hash = result.find(r => r.key === null)?.value;
  if (hash === undefined) throw new Error('config table read returned no hash row');
  if (cached && hash === cached.hash) return { ...cached.rows };
  const rows: Record<string, string> = {};
  for (const r of result) if (r.key !== null) rows[r.key] = r.value;
  tables.set(owner, { hash, rows });
  return { ...rows };
}
