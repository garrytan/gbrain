/**
 * Regression for schema CLI engine routing.
 *
 * Serial because it opens a persistent PGLite database and then hands that
 * database to a CLI subprocess. The subprocess must read the configured path,
 * not silently fall back to the default brain.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const REPO_ROOT = join(import.meta.dir, '..');

describe('gbrain schema configured PGLite routing', () => {
  test('schema stats reads database_path from config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-schema-db-path-'));
    const gbrainDir = join(home, '.gbrain');
    const dbPath = join(gbrainDir, 'configured-brain.pglite');
    mkdirSync(gbrainDir, { recursive: true });

    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: dbPath });
      await engine.initSchema();
      await engine.putPage('people/alice-example', {
        type: 'person',
        title: 'Alice Example',
        compiled_truth: 'Example page',
      });
    } finally {
      await engine.disconnect();
    }

    writeFileSync(
      join(gbrainDir, 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: dbPath, schema_pack: 'gbrain-base' }),
      'utf-8',
    );

    try {
      const result = spawnSync(
        'bun',
        ['run', 'src/cli.ts', 'schema', 'stats', '--json'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          env: {
            ...process.env,
            GBRAIN_DATABASE_URL: '',
            DATABASE_URL: '',
            GBRAIN_HOME: home,
          },
          timeout: 60_000,
        },
      );
      expect(result.status).toBe(0);
      const stats = JSON.parse(result.stdout ?? '');
      expect(stats.aggregate.total_pages).toBe(1);
      expect(stats.aggregate.by_type).toContainEqual({ type: 'person', count: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
