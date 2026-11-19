/**
 * Config table reads that fetch several keys in one statement: one SQL implementation for both engines.
 * Single keys stay on `getConfig` / `getAllConfig`, which honor the request config snapshot.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** The stored `{ key, value }` rows for the named keys, ordered by key; a key with no row is absent. Reads the table, never a request snapshot. */
export async function getConfigValues(exec: LegacyUnscopedRead, keys: readonly string[]): Promise<Array<{ key: string; value: string }>> {
  return exec.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config WHERE key = ANY($1::text[]) ORDER BY key', [[...keys]]);
}
