import { describe, expect, test } from 'bun:test';
import { assertSafeE2EDatabaseUrl } from './e2e/db-safety.ts';

describe('Postgres E2E database safety guard', () => {
  test('allows local test databases', () => {
    expect(() => assertSafeE2EDatabaseUrl('postgresql://postgres:postgres@localhost:5433/gbrain_test')).not.toThrow();
    expect(() => assertSafeE2EDatabaseUrl('postgres://postgres:postgres@127.0.0.1:5433/gbrain-e2e')).not.toThrow();
  });

  test('blocks remote databases by default', () => {
    expect(() => assertSafeE2EDatabaseUrl('postgresql://postgres.example:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres')).toThrow(
      /Refusing to run destructive Postgres E2E/,
    );
  });

  test('blocks local non-test database names by default', () => {
    expect(() => assertSafeE2EDatabaseUrl('postgresql://postgres:postgres@localhost:5433/gbrain')).toThrow(
      /Refusing to run destructive Postgres E2E/,
    );
  });
});
