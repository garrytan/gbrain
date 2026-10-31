import type { Migration } from './types.ts';
import { FACT_INSERT_GUARD_FUNCTION_SQL } from '../facts/insert-guard-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7778: the facts insert guard's purge refusal no longer applies to an
// extraction outcome row (source one of the conversation-facts audit sources
// and text EXTRACTION_COMPLETE or EXTRACTION_NOT_APPLICABLE). A page purge
// tombstoned that shared marker with subject '*', after which no page of the
// source could record its outcome, so every run re-extracted and re-paid for
// the same pages. Brains holding such a tombstone converge on their next run:
// the tombstone row stays (it is history and the restore mirror replays it),
// it just no longer matches a marker. Replaces only the function: its trigger
// already calls it, and re-creating the trigger would take an ACCESS EXCLUSIVE
// lock on facts. No row is read or written.
export const v279: Migration = {
  version: 279,
  name: 'outcome_markers_skip_purge_guard',
  idempotent: true,
  sql: FACT_INSERT_GUARD_FUNCTION_SQL,
};
