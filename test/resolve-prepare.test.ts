/**
 * resolvePrepare precedence tests.
 *
 * The helper in src/core/db.ts decides whether to force `prepare: true|false`
 * on the postgres.js client, or leave it unset (postgres.js default). The
 * decision matters: on Supabase PgBouncer (port 6543) prepared statements
 * break under load, but forcing `prepare: false` on direct Postgres loses
 * plan-cache performance. Precedence ordering (env → URL query → port
 * auto-detect → default) is enforced here so future edits to resolvePrepare
 * cannot silently reshuffle the precedence and reintroduce the bug.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { resolvePrepare } from '../src/core/db.ts';

describe('resolvePrepare', () => {
  afterEach(() => {
    delete process.env.GBRAIN_PREPARE;
  });

  test('returns false for Supabase pooler port 6543', () => {
    expect(resolvePrepare('postgresql://user:pass@host:6543/db')).toBe(false);
  });

  test('returns undefined for direct Postgres port 5432', () => {
    expect(resolvePrepare('postgresql://user:pass@host:5432/db')).toBeUndefined();
  });

  test('returns undefined for default port (no port specified)', () => {
    expect(resolvePrepare('postgresql://user:pass@host/db')).toBeUndefined();
  });

  test('respects ?prepare=false in URL', () => {
    expect(
      resolvePrepare('postgresql://user:pass@host:5432/db?prepare=false'),
    ).toBe(false);
  });

  test('respects ?prepare=true in URL even on port 6543', () => {
    expect(
      resolvePrepare('postgresql://user:pass@host:6543/db?prepare=true'),
    ).toBe(true);
  });

  test('GBRAIN_PREPARE=false overrides everything', () => {
    process.env.GBRAIN_PREPARE = 'false';
    expect(
      resolvePrepare('postgresql://user:pass@host:5432/db?prepare=true'),
    ).toBe(false);
  });

  test('GBRAIN_PREPARE=true overrides auto-detect on 6543', () => {
    process.env.GBRAIN_PREPARE = 'true';
    expect(resolvePrepare('postgresql://user:pass@host:6543/db')).toBe(true);
  });

  test('GBRAIN_PREPARE=0 is falsy', () => {
    process.env.GBRAIN_PREPARE = '0';
    expect(resolvePrepare('postgresql://user:pass@host:6543/db')).toBe(false);
  });

  test('returns undefined for malformed URL', () => {
    expect(resolvePrepare('not-a-url')).toBeUndefined();
  });

  test('handles postgres:// scheme (no ql)', () => {
    expect(resolvePrepare('postgres://user:pass@host:6543/db')).toBe(false);
  });

  test('handles URL with encoded special chars in password', () => {
    expect(
      resolvePrepare('postgresql://user:p%40ss%24word@host:6543/db'),
    ).toBe(false);
  });
});
