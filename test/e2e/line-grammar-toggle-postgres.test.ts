/**
 * Postgres arm of the line-grammar toggle scenarios: settings-bound link
 * extraction, the generation row and the one watermark on a real database
 * (and through transaction-mode PgBouncer when the E2E shard routes there).
 */
import { describe, test } from 'bun:test';
import { concurrentToggleConverges, enableThenDisableConverges, noOpChangesKeepTheGeneration, preparedBeforeChangeStaysStale } from '../helpers/line-grammar-toggle-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres line-grammar toggles converge', () => {
  test('enable then disable re-extracts and follows the setting', () => enableThenDisableConverges(url), 240_000);
  test('no-op changes keep the generation', () => noOpChangesKeepTheGeneration(url), 180_000);
  test('a page prepared before a change stays stale', () => preparedBeforeChangeStaysStale(url), 180_000);
  test('a toggle racing an extraction converges', () => concurrentToggleConverges(url), 240_000);
});
