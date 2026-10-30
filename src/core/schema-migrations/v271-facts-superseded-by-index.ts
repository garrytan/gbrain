import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// facts.superseded_by is a self-referencing FK (ON DELETE SET NULL, v167) with
// no index. Every DELETE on facts (clearConversationFacts, page purge, rename,
// ontology rekey) makes Postgres look up referencing rows with
// `superseded_by = <deleted id>`, and the conversation clear's
// `EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by = f.id)` guard asks the
// same question: with no index each lookup is a Seq Scan of facts, so a
// delete's cost grows with the whole brain. Only superseded rows carry a value,
// so the partial index stays small. Built online (CONCURRENTLY on Postgres);
// an interrupted build leaves an INVALID index that the next initSchema drops
// and rebuilds. Not in schema.sql: the facts table is created by migrations
// (v045), not by the schema blob, so a fresh install gets the index here too.
export const FACTS_SUPERSEDED_BY_INDEX = {
  name: 'idx_facts_superseded_by',
  table: 'facts',
  sql: 'CREATE INDEX IF NOT EXISTS idx_facts_superseded_by ON facts (superseded_by) WHERE superseded_by IS NOT NULL',
};

export const v271: Migration = {
  version: 271,
  name: 'facts_superseded_by_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 271, FACTS_SUPERSEDED_BY_INDEX, { notice: migrationNotice });
  },
};
