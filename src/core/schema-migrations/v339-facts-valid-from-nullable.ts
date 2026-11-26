import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #10288: a fact saved without an event date stores valid_from NULL ("event date
// unknown") instead of its save time, so an event-time window (`recall --since`)
// no longer reads it as a recent event. The column keeps DEFAULT now() for raw
// inserts that omit it; every gbrain writer names the column and passes NULL when
// it knows no date. Existing rows are not rewritten. The ALTER runs only while the
// column is still NOT NULL, so a replay takes no lock on facts.
export const v339: Migration = {
  version: 339,
  name: 'facts_valid_from_nullable',
  idempotent: true,
  sql: `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'facts'::regclass AND attname = 'valid_from' AND attnotnull) THEN
        ALTER TABLE facts ALTER COLUMN valid_from DROP NOT NULL;
      END IF;
    END $$;
  `,
};
