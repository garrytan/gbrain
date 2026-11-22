/** A stored slug over 255 characters is a legacy slug, so delete_page and restore_page can name it. */
import { describe, expect, test } from 'bun:test';
import { isLegacyStoredPageSlug, isOpPageSlug } from '../src/core/ops/context.ts';

describe('legacy stored slugs over 255 characters', () => {
  test('a long slug the storage guard accepts counts as legacy', () => {
    const long = `drive/${'folder-'.repeat(40)}file`;
    expect(long.length).toBeGreaterThan(255);
    expect(isOpPageSlug(long)).toBe(false);
    expect(isLegacyStoredPageSlug(long)).toBe(true);
    expect(isLegacyStoredPageSlug(`${long}/../x`)).toBe(false);
  });
});
