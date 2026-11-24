/**
 * utcJsonbTime / utcCurrentGrant (src/core/engine-sql/access-credentials.ts): the bearer check's `current_grant`
 * timestamps read as UTC text whatever the session TimeZone.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a to_jsonb timestamptz text in any offset (whole hours, half hours, the seconds of a local mean time)
 *    becomes the same instant as `+00:00` text, with its fraction digits kept; other text and non-strings are unchanged;
 *    only the three oauth_clients timestamp keys of `current_grant` change.
 *  - Regression: an offset applied with the wrong sign, a dropped fraction, or another grant field rewritten.
 *  - Why existing coverage misses it: the parity case uses one zone (America/Los_Angeles).
 *  - Seam: none. Pure functions.
 */
import { describe, expect, test } from 'bun:test';
import { utcCurrentGrant, utcJsonbTime } from '../src/core/engine-sql/access-credentials.ts';

describe('utcJsonbTime', () => {
  test('moves any offset to UTC and keeps the fraction digits', () => {
    expect(utcJsonbTime('2026-07-04T08:16:17.123-07:00')).toBe('2026-07-04T15:16:17.123+00:00');
    expect(utcJsonbTime('2026-01-01T19:04:05.5-08:00')).toBe('2026-01-02T03:04:05.5+00:00');
    expect(utcJsonbTime('2026-01-02T08:34:05+05:30')).toBe('2026-01-02T03:04:05+00:00');
    expect(utcJsonbTime('1880-01-01T00:00:00-07:52:58')).toBe('1880-01-01T07:52:58+00:00');
    expect(utcJsonbTime('2026-01-02T03:04:05.000001+00:00')).toBe('2026-01-02T03:04:05.000001+00:00');
  });
  test('leaves other text and non-strings unchanged', () => {
    for (const v of ['infinity', '12026-01-02T03:04:05+00:00', '2026-01-02 03:04:05+00', 'Client oc-tz', null, 5]) expect(utcJsonbTime(v)).toBe(v);
  });
});

describe('utcCurrentGrant', () => {
  test('rewrites only the three timestamp keys of current_grant', () => {
    const row = { id: 't1', current_grant: { client_name: '2026-01-01T19:04:05-08:00', created_at: '2026-01-01T19:04:05-08:00', deleted_at: null, reads_unscoped: '2026-07-04T08:16:17.123-07:00' } };
    expect(utcCurrentGrant(row)).toEqual({ id: 't1', current_grant: { client_name: '2026-01-01T19:04:05-08:00', created_at: '2026-01-02T03:04:05+00:00', deleted_at: null, reads_unscoped: '2026-07-04T15:16:17.123+00:00' } });
    expect(row.current_grant.created_at).toBe('2026-01-01T19:04:05-08:00');
    const bare = { id: 't2' };
    expect(utcCurrentGrant(bare)).toBe(bare);
  });
});
