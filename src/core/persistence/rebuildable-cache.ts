/**
 * #6911: purge-path writes to rebuildable caches. A cache the graduation inventory classifies `rebuild`
 * (query_cache, code_traversal_cache) holds nothing a rebuild cannot regenerate, so a brain where the table is
 * absent purges correctly by skipping it. The existence check runs before the statement because a 42P01 inside a
 * Postgres transaction aborts the whole transaction even when caught. A missing table that holds user data is never
 * skipped: the purge fails loudly rather than claim it cleared rows it could not reach.
 */
import type { BrainEngine } from '../engine.ts';
import { GRADUATION_INVENTORY } from './graduation-inventory.ts';

let rebuildable: ReadonlySet<string> | null = null;
export function isRebuildableCache(table: string): boolean {
  rebuildable ??= new Set(GRADUATION_INVENTORY.entries.filter(e => e.class === 'rebuild' && e.kind === 'table').map(e => e.relation));
  return rebuildable.has(table);
}

/** Whether `table` resolves on the connection's search path, the same resolution the statement that uses it gets. */
export function relationExists(engine: Pick<BrainEngine, 'relationExists'>, table: string): Promise<boolean> {
  return engine.relationExists(table);
}

/**
 * Empty a rebuildable cache and return the rows removed, or null when the cache table does not exist. The query cache (the only
 * one a purge clears) goes through the engine's `clearQueryCache` member.
 */
export async function clearRebuildableCache(tx: Pick<BrainEngine, 'executeRaw' | 'clearQueryCache' | 'relationExists'>, table: string): Promise<number | null> {
  if (!isRebuildableCache(table)) throw new Error(`clearRebuildableCache: ${table} is not a rebuildable cache in the graduation inventory`);
  if (table === 'query_cache') return tx.clearQueryCache();
  if (!await relationExists(tx, table)) return null;
  return (await tx.executeRaw(`DELETE FROM ${table} RETURNING 1`)).length;
}
