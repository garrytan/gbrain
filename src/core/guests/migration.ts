/**
 * The guest-notes schema migration's number, read from the migration registry by the migration's name, so
 * `bun run migrations:renumber` (which rewrites only the migration's filename, export name and version literal, then
 * regenerates the registry) moves every comparison with it. Compare against this, never a literal.
 */
import { MIGRATIONS } from '../schema-migrations/registry.generated.ts';

export const GUEST_NOTES_MIGRATION_NAME = 'guest_notes';

export const GUEST_NOTES_MIGRATION: number = (() => {
  const found = MIGRATIONS.find(m => m.name === GUEST_NOTES_MIGRATION_NAME);
  if (!found) throw new Error('guests/migration.ts: no schema migration named ' + GUEST_NOTES_MIGRATION_NAME);
  return found.version;
})();
