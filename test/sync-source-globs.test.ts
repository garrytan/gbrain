/**
 * TODO #3 — `parseGlobList` defensive parse.
 *
 * `sources.config` is a JSONB column with no schema. The runtime can find
 * anything in `config.include_globs` / `config.exclude_globs`:
 *   - A user `gbrain sources add` wrote `["people/**"]` (the happy path).
 *   - A stray hand-edit wrote `"people/**"` (string, not array).
 *   - A future migration's null default.
 *   - A test fixture that left the column at `{}`.
 *
 * The parse must produce `string[] | undefined` so the downstream
 * `SyncOpts.include` / `SyncOpts.exclude` are either undefined (no filter)
 * or a non-empty list of usable globs. Returning `[]` would make
 * `commands/sync.ts:1454` engage the filter loop with an empty allow-list
 * that classifies every path as `include-glob-miss`.
 */

import { describe, test, expect } from 'bun:test';
import { parseGlobList, computeSourceConfigFingerprint } from '../src/commands/sync.ts';

describe('parseGlobList — JSONB-safe coercion to string[] | undefined', () => {
  test('happy path: array of strings round-trips identically', () => {
    expect(parseGlobList(['people/**', 'companies/**'])).toEqual(['people/**', 'companies/**']);
  });

  test('single-element array returned as-is', () => {
    expect(parseGlobList(['Templates/**'])).toEqual(['Templates/**']);
  });

  test('non-array values return undefined (string, object, number, null)', () => {
    expect(parseGlobList('Templates/**')).toBeUndefined();
    expect(parseGlobList({ globs: ['Templates/**'] })).toBeUndefined();
    expect(parseGlobList(42)).toBeUndefined();
    expect(parseGlobList(null)).toBeUndefined();
    expect(parseGlobList(undefined)).toBeUndefined();
  });

  test('empty array returns undefined (no engagement of the filter loop)', () => {
    // Critical: a literal `[]` must not slip through. Empty `include` in
    // SyncableOptions silently passes everything (good), but empty
    // `exclude` is fine too — the real motivation is to keep `SyncOpts`
    // unset so callers can ignore the field entirely. Symmetric with the
    // `omitted glob flags leave config untouched` regression guard in
    // sources.test.ts.
    expect(parseGlobList([])).toBeUndefined();
  });

  test('mixed array drops non-string entries and keeps the rest', () => {
    expect(parseGlobList(['people/**', 42, null, 'companies/**'])).toEqual([
      'people/**',
      'companies/**',
    ]);
  });

  test('empty strings dropped (a `""` glob would match every path)', () => {
    expect(parseGlobList(['', 'people/**', ''])).toEqual(['people/**']);
  });

  test('array of only empty strings collapses to undefined', () => {
    expect(parseGlobList(['', '', ''])).toBeUndefined();
  });
});

/**
 * #2157 follow-on (sources_config_fingerprint, migration v117).
 *
 * computeSourceConfigFingerprint hashes the walk-affecting fields of
 * sources.config (strategy + include_globs + exclude_globs) so the
 * "Already up to date" gate at performSync's git-HEAD equality check
 * can detect drift and force a re-walk. These cases pin the contract
 * the gate depends on:
 *
 *   - Deterministic over equivalent inputs (order-insensitive,
 *     defensively-coerced via parseGlobList).
 *   - Sensitive to each walk-affecting field separately.
 *   - Insensitive to fields the walker doesn't read (federated,
 *     unrelated keys).
 *   - A toggle-and-revert is a no-op (returns to the original hash).
 *
 * Without the canonicalization the gate would fire spuriously on
 * cosmetic changes (e.g. a user re-ordering their exclude list) and
 * miss real drift (e.g. an add-then-remove that nets to a different
 * effective set than the stored fingerprint).
 */
describe('computeSourceConfigFingerprint — walk-affecting config drift detector', () => {
  test('empty config produces a stable hash', () => {
    const a = computeSourceConfigFingerprint({});
    const b = computeSourceConfigFingerprint({});
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test('null / undefined / missing config all hash the same', () => {
    const empty = computeSourceConfigFingerprint({});
    expect(computeSourceConfigFingerprint(null)).toBe(empty);
    expect(computeSourceConfigFingerprint(undefined)).toBe(empty);
  });

  test('same config → same hash (deterministic)', () => {
    const cfg = { strategy: 'markdown', exclude_globs: ['Templates/**', 'Photos/**'] };
    expect(computeSourceConfigFingerprint(cfg)).toBe(computeSourceConfigFingerprint(cfg));
  });

  test('array order does not affect hash (canonical sort)', () => {
    const a = computeSourceConfigFingerprint({ exclude_globs: ['a/**', 'b/**', 'c/**'] });
    const b = computeSourceConfigFingerprint({ exclude_globs: ['c/**', 'a/**', 'b/**'] });
    expect(a).toBe(b);
  });

  test('exclude_globs change → different hash', () => {
    const a = computeSourceConfigFingerprint({ exclude_globs: ['Templates/**'] });
    const b = computeSourceConfigFingerprint({ exclude_globs: ['Templates/**', 'Photos/**'] });
    expect(a).not.toBe(b);
  });

  test('include_globs change → different hash', () => {
    const a = computeSourceConfigFingerprint({ include_globs: ['people/**'] });
    const b = computeSourceConfigFingerprint({ include_globs: ['people/**', 'companies/**'] });
    expect(a).not.toBe(b);
  });

  test('strategy change → different hash', () => {
    const a = computeSourceConfigFingerprint({ strategy: 'markdown' });
    const b = computeSourceConfigFingerprint({ strategy: 'code' });
    expect(a).not.toBe(b);
  });

  test('strategy unset vs set differ', () => {
    const unset = computeSourceConfigFingerprint({});
    const set = computeSourceConfigFingerprint({ strategy: 'markdown' });
    expect(unset).not.toBe(set);
  });

  test('add-then-remove returns to original hash (toggle is a no-op)', () => {
    const original = computeSourceConfigFingerprint({ exclude_globs: ['Templates/**'] });
    const added = computeSourceConfigFingerprint({ exclude_globs: ['Templates/**', 'Photos/**'] });
    const reverted = computeSourceConfigFingerprint({ exclude_globs: ['Templates/**'] });
    expect(added).not.toBe(original);
    expect(reverted).toBe(original);
  });

  test('non-walk-affecting fields are ignored (federated, unrelated keys)', () => {
    const a = computeSourceConfigFingerprint({ exclude_globs: ['Templates/**'], federated: true });
    const b = computeSourceConfigFingerprint({ exclude_globs: ['Templates/**'], federated: false });
    const c = computeSourceConfigFingerprint({ exclude_globs: ['Templates/**'], some_unrelated_key: 'value' });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test('non-string strategy coerced to null (defensive)', () => {
    // A hand-edited row could leave `strategy: 42` or `strategy: {}` — both
    // collapse to the same shape as `strategy: undefined` so the fingerprint
    // doesn't reflect a value the walker can't honor anyway.
    const empty = computeSourceConfigFingerprint({});
    expect(computeSourceConfigFingerprint({ strategy: 42 })).toBe(empty);
    expect(computeSourceConfigFingerprint({ strategy: {} })).toBe(empty);
    expect(computeSourceConfigFingerprint({ strategy: null })).toBe(empty);
  });

  test('defensive parsing: mixed-type glob arrays hash same as cleaned arrays', () => {
    // parseGlobList drops non-string + empty entries; the fingerprint must
    // reflect what the walker actually uses, not what the raw row says.
    const dirty = computeSourceConfigFingerprint({
      exclude_globs: ['Templates/**', 42, null, '', 'Photos/**'],
    });
    const clean = computeSourceConfigFingerprint({
      exclude_globs: ['Templates/**', 'Photos/**'],
    });
    expect(dirty).toBe(clean);
  });

  test('empty array and missing field hash identically', () => {
    const missing = computeSourceConfigFingerprint({});
    const emptyArray = computeSourceConfigFingerprint({ exclude_globs: [] });
    const emptyAfterClean = computeSourceConfigFingerprint({ exclude_globs: ['', '', ''] });
    expect(emptyArray).toBe(missing);
    expect(emptyAfterClean).toBe(missing);
  });

  test('non-array exclude_globs (string, object) hash same as missing', () => {
    const missing = computeSourceConfigFingerprint({});
    expect(computeSourceConfigFingerprint({ exclude_globs: 'Templates/**' })).toBe(missing);
    expect(computeSourceConfigFingerprint({ exclude_globs: { foo: 'bar' } })).toBe(missing);
  });

  test('SHA-256 output shape: 64 hex characters', () => {
    const fp = computeSourceConfigFingerprint({
      strategy: 'markdown',
      include_globs: ['people/**'],
      exclude_globs: ['Templates/**', '.git/**'],
    });
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});
