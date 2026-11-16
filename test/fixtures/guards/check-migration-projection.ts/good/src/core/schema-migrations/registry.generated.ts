// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'add_column', sql: 'ALTER TABLE pages ADD COLUMN IF NOT EXISTS extra TEXT;' },
  { version: 2, name: 'chunker_reset', sql: 'UPDATE pages SET chunker_version = 0 WHERE chunker_version IS NULL;' },
  { version: 3, name: 'trigger_function', sql: `CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN UPDATE pages SET knowledge_revision = gen_random_uuid() WHERE id = NEW.page_id; RETURN NULL; END $fn$;` },
  { version: 4, name: 'listed_reset', sql: 'UPDATE pages p SET text_projection_revision = NULL WHERE p.slug = \'x\';' },
  { version: 5, name: 'comment_only', sql: '-- UPDATE pages SET title = lower(title)\nSELECT 1;' },
];
