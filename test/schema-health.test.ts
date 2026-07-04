import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('schema health handshake', () => {
  test('reports stale schema versions without touching newer health columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-schema-health-'));
    tempDirs.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    try {
      await engine.initSchema();
      await engine.setConfig('version', '58');

      const health = await engine.getHealth();

      expect(health).toMatchObject({
        page_count: 0,
        schema_version: 58,
        required_schema_version: LATEST_VERSION,
        schema_up_to_date: false,
      });
    } finally {
      await engine.disconnect();
    }
  });

  test('reports current schema versions on initialized databases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-schema-health-current-'));
    tempDirs.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    try {
      await engine.initSchema();

      const health = await engine.getHealth();

      expect(health.schema_version).toBe(LATEST_VERSION);
      expect(health.required_schema_version).toBe(LATEST_VERSION);
      expect(health.schema_up_to_date).toBe(true);
    } finally {
      await engine.disconnect();
    }
  });
});
