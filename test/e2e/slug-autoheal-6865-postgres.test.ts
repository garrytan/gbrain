/** Postgres arm of test/slug-autoheal-6865.test.ts (#6865). */
import { describe, test } from 'bun:test';
import { commentedLineNamingPageStays, declaredSlugRecheckedAtPublication, existingPageStopsAndAsks, healNeverEditsInFlight, killSwitchKeepsHold, olderVerdictRecheckedAfterUpgrade, strayLineHealedBySync } from '../helpers/slug-autoheal-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres stray frontmatter slug: lines (#6865)', () => {
  test('the next sync removes a line naming no page and indexes the file under its path', () => strayLineHealedBySync(url), 180_000);
  test('sync.slug_conflicts.auto_remove false keeps the file held and says so', () => killSwitchKeepsHold(url), 180_000);
  test('a line naming an existing page (file-backed or database-only) stays held and the verdict names both pages', () => existingPageStopsAndAsks(url), 180_000);
  test('no edit while the source syncs, the path is busy, the file changed since the hold, or under remote authority', () => healNeverEditsInFlight(url), 180_000);
  test('a verdict an older gbrain recorded is rechecked, and the next sync heals the file', () => olderVerdictRecheckedAfterUpgrade(url), 180_000);
  test('a slug: line with a trailing YAML comment naming an existing page stays held', () => commentedLineNamingPageStays(url), 180_000);
  test('a file created at the declared slug after the heal read the checkout refuses the write', () => declaredSlugRecheckedAtPublication(url), 180_000);
});
