/**
 * Cross-engine schema test — migration 21 adds interaction_id
 * to three immutable event tables.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const ENGINE_COLD_START_BUDGET_MS = 30_000;

describe('migration 21 — interaction_id on event rows', () => {
  test('SQLite: interaction_id column exists on three tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-m21-sqlite-'));
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();

      const version = await engine.getConfig('version');
      expect(Number(version)).toBeGreaterThanOrEqual(21);
      expect(Number(version)).toBe(LATEST_VERSION);

      const db = (engine as any).database;
      for (const table of [
        'canonical_handoff_entries',
        'memory_candidate_supersession_entries',
        'memory_candidate_contradiction_entries',
      ]) {
        const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        const names = cols.map((c) => c.name);
        expect(names).toContain('interaction_id');
      }
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }, ENGINE_COLD_START_BUDGET_MS);

  test('PGLite: interaction_id column exists on three tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-m21-pglite-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: join(dir, 'pglite') });
      await engine.initSchema();

      for (const table of [
        'canonical_handoff_entries',
        'memory_candidate_supersession_entries',
        'memory_candidate_contradiction_entries',
      ]) {
        const { rows } = await (engine as any).db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND column_name = 'interaction_id'`,
          [table],
        );
        expect(rows.length).toBe(1);
      }
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }, ENGINE_COLD_START_BUDGET_MS);
});
