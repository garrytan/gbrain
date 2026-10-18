/**
 * `idx_facts_fts`, the facts keyword index (`factsFtsDocument` under a literal
 * text search configuration), built and replaced without blocking writers or
 * leaving search without an index. The facts-index migration and
 * `gbrain reindex-search-vector` both call `ensureFactsFtsIndex`.
 *
 * The new definition is built as `idx_facts_fts_next` (CONCURRENTLY on
 * Postgres through `buildIndexOnline`), then one short transaction renames the
 * live index to `idx_facts_fts_old` and the new one into place; renaming an
 * index takes no lock that blocks reads or writes. The old index is dropped
 * last (CONCURRENTLY on Postgres). Every interrupted state converges on a
 * rerun: a current `idx_facts_fts` clears the leftovers, an invalid or stale
 * `_next` is dropped and rebuilt, and a stray `_old` is dropped before the swap.
 */

import type { BrainEngine } from '../engine.ts';
import { factsFtsIndexSql } from '../fts-language.ts';
import { buildIndexOnline } from '../schema-migrations/helpers.ts';

export const FACTS_FTS_INDEX = 'idx_facts_fts';
const NEXT = 'idx_facts_fts_next';
const OLD = 'idx_facts_fts_old';

export type FactsFtsSwapStep = 'built' | 'renamed';

async function indexState(engine: BrainEngine, name: string, lang: string): Promise<'missing' | 'current' | 'stale'> {
  const [row] = await engine.executeRaw<{ valid: boolean; def: string }>(
    'SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indexrelid = to_regclass($1)', [name]);
  if (!row) return 'missing';
  return row.valid && row.def.includes(`to_tsvector('${lang}'::regconfig`) && row.def.includes('entity_slug') ? 'current' : 'stale';
}

async function dropIndex(engine: BrainEngine, version: number, name: string): Promise<void> {
  await engine.runMigration(version, engine.kind === 'postgres' ? `DROP INDEX CONCURRENTLY IF EXISTS ${name}` : `DROP INDEX IF EXISTS ${name}`);
}

/** Leaves a valid `idx_facts_fts` under `lang`; `swapped` when it built and swapped in a new one. */
export async function ensureFactsFtsIndex(
  engine: BrainEngine,
  opts: { lang: string; version: number; notice?: (line: string) => void; onStep?: (step: FactsFtsSwapStep) => Promise<void> },
): Promise<'present' | 'swapped'> {
  const { lang, version } = opts;
  if (await indexState(engine, FACTS_FTS_INDEX, lang) === 'current') {
    await dropIndex(engine, version, NEXT);
    await dropIndex(engine, version, OLD);
    return 'present';
  }
  if (await indexState(engine, NEXT, lang) === 'stale') await dropIndex(engine, version, NEXT);
  const built = await buildIndexOnline(engine, version, { name: NEXT, table: 'facts', sql: factsFtsIndexSql(NEXT, lang) }, { notice: opts.notice });
  if (built === 'building') throw new Error(`${NEXT} is being built by another session; rerun once it finishes`);
  await opts.onStep?.('built');
  await dropIndex(engine, version, OLD);
  await engine.transaction(async tx => {
    await tx.executeRaw(`ALTER INDEX IF EXISTS ${FACTS_FTS_INDEX} RENAME TO ${OLD}`);
    await tx.executeRaw(`ALTER INDEX ${NEXT} RENAME TO ${FACTS_FTS_INDEX}`);
  });
  await opts.onStep?.('renamed');
  await dropIndex(engine, version, OLD);
  return 'swapped';
}
