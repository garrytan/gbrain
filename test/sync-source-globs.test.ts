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
import { parseGlobList } from '../src/commands/sync.ts';

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
