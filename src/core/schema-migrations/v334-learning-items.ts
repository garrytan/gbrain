import type { Migration } from './types.ts';
import { LEARNING_ITEMS_SCHEMA_SQL } from '../learning/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Nightly learning PR 1: learning_items, the ledger of what each cycle learned (src/core/learning/). Pointers only: a
// row names its target row and never copies its text or visibility (DDL and rationale in learning/schema.ts, which
// fresh installs also get through src/schema.sql). Bookkeeping, not brain content: a repo-less brain gets it unchanged.
export const v334: Migration = {
  version: 334,
  name: 'learning_items',
  idempotent: true,
  sql: LEARNING_ITEMS_SCHEMA_SQL,
};
