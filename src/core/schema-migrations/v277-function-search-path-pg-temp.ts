import type { Migration } from './types.ts';
import { hardenFunctionSearchPaths } from '../function-search-path.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7632: every gbrain function that pins a search_path gets pg_temp appended last (src/core/function-search-path.ts),
// so a temp table or view named like a ledger no longer hides it from a guard. ALTER only, no body changes. ALTER
// FUNCTION needs the owner: a function the migrating role does not own is left as it was; the end of the migration run
// names it on stderr (src/core/migrate.ts), and doctor's function_search_path check keeps failing with the SQL to run as
// its owner. One short transaction with the migration's statement and lock timeouts.

export const v277: Migration = {
  version: 277,
  name: 'function_search_path_pg_temp',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => { await hardenFunctionSearchPaths(engine); },
};
