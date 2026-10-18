/** PGLite arm of the #6865 stray slug: line scenarios (test/helpers/slug-autoheal-scenarios.ts); Postgres: test/e2e/slug-autoheal-6865-postgres.test.ts. */
import { describe, test } from 'bun:test';
import { commentedLineNamingPageStays, declaredSlugRecheckedAtPublication, existingPageStopsAndAsks, healNeverEditsInFlight, killSwitchKeepsHold, olderVerdictRecheckedAfterUpgrade, strayLineHealedBySync } from './helpers/slug-autoheal-scenarios.ts';

describe('PGLite stray frontmatter slug: lines (#6865)', () => {
  test('the next sync removes a line naming no page and indexes the file under its path', () => strayLineHealedBySync(), 180_000);
  test('sync.slug_conflicts.auto_remove false keeps the file held and says so', () => killSwitchKeepsHold(), 180_000);
  test('a line naming an existing page (file-backed or database-only) stays held and the verdict names both pages', () => existingPageStopsAndAsks(), 180_000);
  test('no edit while the source syncs, the path is busy, the file changed since the hold, or under remote authority', () => healNeverEditsInFlight(), 180_000);
  test('a verdict an older gbrain recorded is rechecked, and the next sync heals the file', () => olderVerdictRecheckedAfterUpgrade(), 180_000);
  test('a slug: line with a trailing YAML comment naming an existing page stays held', () => commentedLineNamingPageStays(), 180_000);
  test('a file created at the declared slug after the heal read the checkout refuses the write', () => declaredSlugRecheckedAtPublication(), 180_000);
});
