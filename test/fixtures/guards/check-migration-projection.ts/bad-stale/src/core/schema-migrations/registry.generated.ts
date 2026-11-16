// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'add_column', sql: 'ALTER TABLE pages ADD COLUMN IF NOT EXISTS extra TEXT;' },
];
