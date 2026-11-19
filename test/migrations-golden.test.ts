/**
 * Migrations full-record golden (refactor wave 1: A11 + EO19).
 *
 * Protects: every MIGRATIONS entry (version set incl. gaps 17-19 and 100, name,
 * exact sql / sqlFor text, array order (the runner sorts by version; the array itself is not ascending), transaction, idempotent, handler and verify
 * presence, normalized handler/verify source and referenced helpers) is
 * unchanged by W3's split of the array into `src/core/schema-migrations/`.
 * Fails when: a migration is dropped, duplicated, renumbered, reordered, or
 * its SQL, flags or handler logic change during a move.
 * Why new: no test pinned all 170 records; existing tests assert a few versions.
 * Normalizer `migrations-record-v1`: identity over already-deterministic data
 * (hashes of exact strings and of normalized tokens); proven stable by the
 * double capture below.
 */

import { describe, expect, test } from 'bun:test';
import { LATEST_VERSION, MIGRATIONS } from '../src/core/migrate.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { buildMigrationsGolden, type MigrationsGolden } from './helpers/migration-records.ts';

const normalizer = defineNormalizer('migrations-record-v1', (g: MigrationsGolden) => g);

describe('migrations full-record golden', () => {
  test('all MIGRATIONS records match the master golden', async () => {
    const golden = await expectNormalizerStable(() => buildMigrationsGolden(MIGRATIONS), normalizer);
    expect(golden.count).toBe(MIGRATIONS.length);
    expect(golden.latest).toBe(LATEST_VERSION);
    expectGolden('migrations/records', golden, normalizer);
  }, 60_000);

  test('versions are unique and the runner applies them ascending; gaps 17-19 and 100 stay gaps', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    const sorted = [...versions].sort((a, b) => a - b);
    const golden = buildMigrationsGolden(MIGRATIONS);
    expect(golden.gaps).toEqual([17, 18, 19, 100]);
    expect(sorted[0]).toBe(2);
    expect(sorted[sorted.length - 1]).toBe(LATEST_VERSION);
  }, 60_000);
});
