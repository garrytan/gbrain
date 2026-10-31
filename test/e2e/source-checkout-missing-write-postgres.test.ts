/** GST-465 on Postgres; the scenarios and their contract are in test/helpers/source-checkout-missing-scenarios.ts. */
import { describe, test } from 'bun:test';
import { hasDatabase } from './helpers.ts';
import { missingSourceCheckout, missingSourceSubdirectory } from '../helpers/source-checkout-missing-scenarios.ts';

const d = hasDatabase() ? describe : describe.skip;

d('GST-465: member-token page writes when the source directory is missing (Postgres)', () => {
  test('a missing source subdirectory is created and the same token reads the page back', () => missingSourceSubdirectory(process.env.DATABASE_URL), 240_000);
  test('a missing source checkout refuses with source_checkout_missing and writes nothing', () => missingSourceCheckout(process.env.DATABASE_URL), 240_000);
});
