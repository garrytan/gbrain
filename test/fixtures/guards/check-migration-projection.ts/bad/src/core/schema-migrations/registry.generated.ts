// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'lower_titles', sql: 'UPDATE pages SET title = lower(title), chunker_version = 0;' },
];
