/**
 * Config table reads that fetch several keys in one statement: one SQL implementation for both engines.
 * Single keys stay on `getConfig` / `getAllConfig`, which honor the request config snapshot.
 */
import type { LegacyUnscopedRead } from './brands.ts';

const CONFIG_VALUES_SQL = 'SELECT key, value FROM config WHERE key = ANY($1::text[]) ORDER BY key';
const CONFIG_VALUES_SHARE_SQL = 'SELECT key, value FROM config WHERE key = ANY($1::text[]) ORDER BY key FOR SHARE';

/** `getConfigValues` options. `lock: 'share'` holds the rows read FOR SHARE until the caller's transaction ends. */
export interface ConfigValuesOptions { lock?: 'share' }

/**
 * The stored `{ key, value }` rows for the named keys, ordered by key; a key with no row is absent. Reads the table,
 * never a request snapshot. `lock: 'share'` adds FOR SHARE, so a config write waits for the caller's transaction.
 */
export async function getConfigValues(exec: LegacyUnscopedRead, keys: readonly string[], opts?: ConfigValuesOptions): Promise<Array<{ key: string; value: string }>> {
  const sql = opts?.lock === 'share' ? CONFIG_VALUES_SHARE_SQL : CONFIG_VALUES_SQL;
  return exec.executeRaw<{ key: string; value: string }>(sql, [[...keys]]);
}
