import type { Migration } from './types.ts';
import { FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL } from '../facts/withdrawal-schema.ts';
import { FACT_INSERT_GUARD_FUNCTION_SQL } from '../facts/insert-guard-schema.ts';
import { REFUSE_PURGED_FACT_FUNCTION_SQL } from '../facts/purge-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-574 A1: conversation extraction now keeps a name key (a bare slug such as alice-example, no page) on a fact
// whose person or company has no page (facts.unbacked_entity_keys). The three facts guards treat a row on such a key
// (no directory, no live page at that slug in its source) as subject '*': a withdrawal or purge tombstone of its claim
// under any subject expires or refuses it, so a claim forgotten under a page that is later deleted, or forgotten under
// the key before a page was written, never comes back under the key. Rows with a page or no entity match as before.
// Replaces only the functions: their triggers already call them, and re-creating a trigger would take an ACCESS
// EXCLUSIVE lock on facts. The migration run's search_path hardening (function-search-path.ts) appends pg_temp again.
// No row is read or written.
export const v320: Migration = {
  version: 320,
  name: 'unbacked_entity_keys_guards',
  idempotent: true,
  sql: `${FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL};\n${FACT_INSERT_GUARD_FUNCTION_SQL};\n${REFUSE_PURGED_FACT_FUNCTION_SQL};`,
};
