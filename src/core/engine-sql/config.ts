/**
 * Config table reads that fetch several keys in one statement: one SQL implementation for both engines.
 * Single keys stay on `getConfig` / `getAllConfig`, which honor the request config snapshot.
 */
import type { LegacyUnscopedRead } from './brands.ts';
/**
 * Config table reads that fetch several keys in one statement: one SQL implementation for both engines.
 * Single keys stay on `getConfig` / `getAllConfig`, which honor the request config snapshot.
 */
import type { BrainEngine } from '../engine.ts';

/** The stored `{ key, value }` rows for the named keys, ordered by key; a key with no row is absent. Reads the table, never a request snapshot. */
export async function getConfigValues(exec: LegacyUnscopedRead, keys: readonly string[]): Promise<Array<{ key: string; value: string }>> {
  return exec.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config WHERE key = ANY($1::text[]) ORDER BY key COLLATE "C"', [[...keys]]);
}

/**
 * One key's stored value, null without a row, on the engine's own `executeRaw` (inside `transaction()` the transaction's
 * connection). The text is the statement persistence/sync-admission.ts readSyncAdmission ran, byte for byte, which
 * page-mutations.ts batchSharedReads and config-snapshot.ts preparationConfigView also recognize.
 */
export async function readStoredConfigValue(raw: Pick<BrainEngine, 'executeRaw'>, key: string): Promise<string | null> {
  const [row] = await raw.executeRaw<{ value: string | null }>('SELECT value FROM config WHERE key=$1', [key]);
  return row?.value ?? null;
}
