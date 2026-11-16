// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'quoted_table', sql: 'UPDATE "pages" SET title = lower(title);' },
];
