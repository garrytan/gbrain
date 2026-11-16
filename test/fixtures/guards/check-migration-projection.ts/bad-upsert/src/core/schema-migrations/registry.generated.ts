// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'seed_titles', sql: "INSERT INTO pages (slug, title) VALUES ('x', 'X') ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title;" },
];
