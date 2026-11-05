/** GST-465 on PGLite (keyless); the scenarios and their contract are in test/helpers/source-checkout-missing-scenarios.ts. */
import { describe, test } from 'bun:test';
import { missingSourceCheckout, missingSourceSubdirectory, ownershipRecordNotPrivate, recreatedCheckout } from './helpers/source-checkout-missing-scenarios.ts';

describe('GST-465: member-token page writes when the source directory is missing (PGLite)', () => {
  test('a missing source subdirectory is created and the same token reads the page back', () => missingSourceSubdirectory(), 120_000);
  test('a missing source checkout refuses with source_checkout_missing and writes nothing', () => missingSourceCheckout(), 120_000);
  test('a checkout recreated at its recorded path refuses physical_root_directory_changed and names the owner-run self-transfer', () => recreatedCheckout(), 120_000);
  test('an ownership record readable by others refuses ownership_record_not_private and doctor names the chmod', () => ownershipRecordNotPrivate(), 120_000);
});
