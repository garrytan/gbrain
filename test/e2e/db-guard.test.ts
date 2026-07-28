/**
 * Unit tests for the setupDB production guard (assertSafeE2eDatabaseUrl).
 * Pure — no database connection; runs with or without DATABASE_URL set.
 */

import { describe, test, expect } from 'bun:test';
import { assertSafeE2eDatabaseUrl } from './helpers.ts';

const NO_ENV = {} as Record<string, string | undefined>;

describe('assertSafeE2eDatabaseUrl', () => {
  test('allows the canonical CI test database', () => {
    expect(() =>
      assertSafeE2eDatabaseUrl('postgresql://postgres:postgres@localhost:5433/gbrain_test', NO_ENV),
    ).not.toThrow();
  });

  test('allows test as any word segment', () => {
    for (const name of ['test', 'test_gbrain', 'e2e-test', 'gbrain_test_2', 'TEST_DB']) {
      expect(() =>
        assertSafeE2eDatabaseUrl(`postgresql://u:p@localhost:5432/${name}`, NO_ENV),
      ).not.toThrow();
    }
  });

  test('refuses production-looking database names', () => {
    for (const name of ['gbrain', 'postgres', 'prod', 'gbrain_live', 'contest', 'latest']) {
      expect(() =>
        assertSafeE2eDatabaseUrl(`postgresql://u:p@localhost:5432/${name}`, NO_ENV),
      ).toThrow(/does not look like a test database/);
    }
  });

  test('refuses a Supabase-style pooler URL with a bare postgres db', () => {
    expect(() =>
      assertSafeE2eDatabaseUrl(
        'postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
        NO_ENV,
      ),
    ).toThrow(/does not look like a test database/);
  });

  test('explicit exact-name override opts a non-test database in', () => {
    expect(() =>
      assertSafeE2eDatabaseUrl('postgresql://u:p@localhost:5432/gbrain', {
        GBRAIN_E2E_ALLOW_DB: 'gbrain',
      }),
    ).not.toThrow();
  });

  test('override must match the exact database name', () => {
    expect(() =>
      assertSafeE2eDatabaseUrl('postgresql://u:p@localhost:5432/gbrain', {
        GBRAIN_E2E_ALLOW_DB: 'other_db',
      }),
    ).toThrow(/does not look like a test database/);
  });

  test('refuses unparseable URLs and missing database names', () => {
    expect(() => assertSafeE2eDatabaseUrl('not a url', NO_ENV)).toThrow(/not a parseable URL/);
    expect(() => assertSafeE2eDatabaseUrl('postgresql://u:p@localhost:5432/', NO_ENV)).toThrow(
      /no database name/,
    );
  });
});
