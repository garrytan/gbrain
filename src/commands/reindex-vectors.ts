/**
 * `gbrain reindex --vectors [--dry-run] [--json]` — rebuild every HNSW vector
 * index in the brain from the stored vectors.
 *
 * #4616: a PGLite WAL reset (auto-repair or `gbrain pglite-repair`) resets the
 * log in place but never rebuilds indexes, so an HNSW index can miss rows
 * written just before the crash. Those pages stay reachable by `gbrain get`
 * and keyword search while vector search never returns them. Rebuilding the
 * index from the table is the fix; no vector is re-embedded and nothing is
 * paid. Postgres rebuilds concurrently so reads and writes continue.
 */
import type { BrainEngine } from '../core/engine.ts';
import { quoteIdentifier } from '../core/search/embedding-column.ts';
import { withHnswBuildMemory } from '../core/vector-index.ts';

export const REINDEX_VECTORS_COMMAND = 'gbrain reindex --vectors';

export interface ReindexVectorsResult {
  indexes: { table: string; index: string }[];
  rebuilt: number;
  dry_run: boolean;
}

export async function runReindexVectors(engine: BrainEngine, args: string[]): Promise<ReindexVectorsResult> {
  const dryRun = args.includes('--dry-run');
  const rows = (await engine.executeRaw<{ table: string; index: string; column: string }>(
    `SELECT p.tablename AS table, p.indexname AS index, a.attname AS column FROM pg_indexes p
       JOIN pg_index i ON i.indexrelid = to_regclass(quote_ident(p.indexname))
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE p.schemaname = current_schema() AND p.indexdef ~* 'USING hnsw' ORDER BY p.tablename, p.indexname`));
  const indexes = rows.map(({ table, index }) => ({ table, index }));
  let rebuilt = 0;
  for (const { table, index, column } of dryRun ? [] : rows) {
    if (!args.includes('--json')) process.stderr.write(`[reindex] rebuilding ${table}.${index}\n`);
    await withHnswBuildMemory(engine, table, column, () =>
      engine.executeRaw(`REINDEX INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}${quoteIdentifier(index)}`));
    rebuilt++;
  }
  const result = { indexes, rebuilt, dry_run: dryRun };
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else console.log(dryRun
    ? `reindex --vectors: would rebuild ${indexes.length} vector index(es): ${indexes.map(i => i.index).join(', ') || '(none)'}`
    : `reindex --vectors: rebuilt ${rebuilt} vector index(es)`);
  return result;
}
