/**
 * put_page's "did you mean an existing page?" advisory on creates: lexical
 * tiers, never on updates, never naming a page the caller cannot read, and
 * slugs only. Managed PGLite brain; Postgres arm in test/e2e/p5-graph-postgres.test.ts.
 */
import { test } from 'bun:test';
import { similarPagesOnCreate, similarPagesSkipPrivate } from './helpers/similar-pages-scenarios.ts';

test('creates get lexical candidates with their evidence; updates and distinct pages get none', () => similarPagesOnCreate(), 120_000);
test('a caller that may not read private pages is never pointed at one', () => similarPagesSkipPrivate(), 120_000);
