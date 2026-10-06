/**
 * Postgres arms of the similar-pages scenarios (PGLite: test/put-page-similar-pages.test.ts).
 */
import { describe, test } from 'bun:test';
import { similarPagesOnCreate, similarPagesSkipPrivate } from '../helpers/similar-pages-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres similar pages', () => {
  test('creates get lexical candidates; updates and distinct pages get none', () => similarPagesOnCreate(url), 180_000);
  test('private pages are never named to a caller that may not read them', () => similarPagesSkipPrivate(url), 180_000);
});
