/** Postgres arm of test/legacy-slug-delete.test.ts (#6212). */
import { describe, test } from 'bun:test';
import { legacySlugLifecycle, legacySlugRefusals } from '../helpers/legacy-slug-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres legacy stored slugs (#6212)', () => {
  test('a legacy row soft-deletes, restores and purges database-only', () => legacySlugLifecycle(url), 180_000);
  test('a legacy row with a recorded source_path is also database-only', () => legacySlugLifecycle(url, { sourcePath: true }), 180_000);
  test('nothing else accepts the legacy grammar, and remote purge stays denied', () => legacySlugRefusals(url), 180_000);
});
