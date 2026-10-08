/** #6212 on PGLite; the Postgres arm is test/e2e/legacy-slug-delete-postgres.test.ts. */
import { describe, expect, test } from 'bun:test';
import { isLegacyStoredPageSlug, isOpPageSlug } from '../src/core/ops/context.ts';
import { legacySlugLifecycle, legacySlugRefusals } from './helpers/legacy-slug-scenarios.ts';

describe('#6212 legacy stored slugs', () => {
  test('only a slug the storage guard still accepts counts as legacy', () => {
    expect(isOpPageSlug('people/jane-doe')).toBe(true);
    expect(isLegacyStoredPageSlug('people/jane-doe')).toBe(false);
    expect(isLegacyStoredPageSlug('people/jane doe')).toBe(true);
    for (const unsafe of ['people/../x', '/people/x', 'people\\x', 'people/%2e%2e', 'people/a\u202eb', 'people/a\u0000b', '']) {
      expect(isLegacyStoredPageSlug(unsafe)).toBe(false);
    }
  });

  test('a legacy row soft-deletes, restores and purges database-only; the vault file and the real page survive', () => legacySlugLifecycle(), 120_000);
  test('a legacy row with a recorded source_path is also database-only', () => legacySlugLifecycle(undefined, { sourcePath: true }), 120_000);
  test('nothing else accepts the legacy grammar, and remote purge stays denied', () => legacySlugRefusals(), 120_000);
});
