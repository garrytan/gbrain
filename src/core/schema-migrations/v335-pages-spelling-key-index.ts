import type { BrainEngine } from '../engine.ts';
import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';
import { serverEncoding, SPELLING_KEY_INDEX, SPELLING_KEY_INDEX_SQL } from '../slug-spelling-key.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Finding every stored spelling that reads as one slug (a page saved with capitals, or in decomposed Unicode, before
// writes composed every slug) filtered all of a source's pages on an expression no index held, and a slug made only of
// non-ASCII letters (all Chinese, say) matched every page whose ASCII-only key is empty. This builds an index on a key
// that keeps non-ASCII letters (see src/core/slug-spelling-key.ts), so the lookup reads only the matching rows. The
// reads return the same pages as before. Postgres builds it CONCURRENTLY, after dropping an INVALID leftover of an
// interrupted build; PGLite builds it inline. schema.sql leaves it out: it replays on every boot, where a plain CREATE
// INDEX would block page writes. An older gbrain runs against the new index unchanged and just does not use it.
async function buildSpellingIndex(engine: BrainEngine): Promise<void> {
  // The key holds characters only a UTF8 database can represent; on any other encoding the index is not built (the upgrade
  // goes on, lookups run as they did before it, and gbrain repair slug-spelling refuses there).
  if (await serverEncoding(engine) !== 'UTF8') {
    migrationNotice(`  [335] ${SPELLING_KEY_INDEX} skipped: the database encoding is not UTF8\n`);
    return;
  }
  const built = await buildIndexOnline(engine, 335, { name: SPELLING_KEY_INDEX, table: 'pages', sql: SPELLING_KEY_INDEX_SQL }, { notice: migrationNotice });
  if (built === 'building') throw new Error(`${SPELLING_KEY_INDEX} is being built by another session; rerun the migration once it finishes`);
}

export const v335: Migration = {
  version: 335,
  name: 'pages_spelling_key_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: buildSpellingIndex,
};
