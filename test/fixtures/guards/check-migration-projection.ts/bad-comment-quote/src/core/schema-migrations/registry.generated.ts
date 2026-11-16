// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'quoted_dashes', sql: "SELECT '--x'; UPDATE pages SET slug = lower(slug);" },
];
