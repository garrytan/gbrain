// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'atomic_then_do', sql: 'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END; DO $$ BEGIN UPDATE pages SET title = lower(title); END $$;' },
];
