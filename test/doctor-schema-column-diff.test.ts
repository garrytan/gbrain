/**
 * #4421 — doctor's schema_version check compared ONLY the ledger counter
 * (config.version vs LATEST_VERSION). A PgBouncer transaction-mode pooler
 * can swallow an ALTER TABLE while the migration runner still advances the
 * counter, leaving doctor green over a physically narrower table — the
 * exact drift schema-verify.ts exists to catch, except doctor never called
 * it. Doctor now runs a READ-ONLY column diff (`detectMissingColumns`, the
 * detection half of verifySchema with no self-heal) and downgrades
 * schema_version to warn naming the missing columns + the
 * `gbrain init --migrate-only` hint.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { detectMissingColumns } from '../src/core/schema-verify.ts';
import { doctorFileSource } from './helpers/doctor-source.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('detectMissingColumns (#4421)', () => {
  test('freshly-initialized schema has no missing columns', async () => {
    const diff = await detectMissingColumns(engine);
    expect(diff.checked).toBeGreaterThan(50);
    expect(diff.missing).toEqual([]);
  });

  test('a dropped column is detected read-only (no self-heal)', async () => {
    await engine.executeRaw('ALTER TABLE pages DROP COLUMN import_filename');
    try {
      const diff = await detectMissingColumns(engine);
      expect(diff.missing).toContainEqual({ table: 'pages', column: 'import_filename' });
      // READ-ONLY contract: a second diff still sees it missing — nothing
      // was healed behind the caller's back.
      const again = await detectMissingColumns(engine);
      expect(again.missing).toContainEqual({ table: 'pages', column: 'import_filename' });
    } finally {
      await engine.executeRaw('ALTER TABLE pages ADD COLUMN IF NOT EXISTS import_filename TEXT');
    }
  });
});

describe('doctor schema_version wires the column diff (#4421)', () => {
  // Positional source guard (doctor-source helper pattern): the ledger-ok
  // branch must consult detectMissingColumns BEFORE pushing its ok check, and
  // the warn message must carry the migrate-only hint.
  test('ledger-ok branch calls detectMissingColumns and hints init --migrate-only', () => {
    const src = doctorFileSource('doctor.ts');
    const diffIdx = src.indexOf('detectMissingColumns');
    expect(diffIdx).toBeGreaterThan(-1);
    expect(src).toContain('gbrain init --migrate-only');
    // The diff arm lives inside the schema_version ledger-current branch.
    const anchor = src.indexOf('schemaVersion >= LATEST_VERSION');
    expect(anchor).toBeGreaterThan(-1);
    expect(diffIdx).toBeGreaterThan(anchor);
  });
});
