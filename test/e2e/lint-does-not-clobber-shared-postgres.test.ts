/**
 * Regression: runLintCore's config-lift helper must not disconnect the
 * module-level Postgres singleton that another live PostgresEngine is using.
 *
 * Field failure shape:
 *   1. A shared PostgresEngine is connected via db.ts's module singleton.
 *   2. lint opens a temporary engine just to read DB-backed config.
 *   3. The temporary engine disconnects and calls db.disconnect().
 *   4. The shared engine's next getConfig() explodes with
 *      "connect() has not been called".
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupDB, teardownDB, getEngine } from './helpers.ts';
import { runLintCore } from '../../src/commands/lint.ts';

describe('E2E: lint DB-config lift preserves shared Postgres connection', () => {
  let dir: string;

  beforeAll(async () => {
    await setupDB();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-e2e-lint-'));
    writeFileSync(
      join(dir, 'sample.md'),
      '# Sample\n\nPlain markdown body.\n',
    );
  }, 30_000);

  afterAll(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    await teardownDB();
  });

  test('runLintCore returns without disconnecting the shared engine', async () => {
    const shared = getEngine();

    await expect(runLintCore({ target: dir, fix: true, dryRun: false })).resolves.toBeTruthy();
    await expect(shared.getConfig('schema_version')).resolves.toBe('1');
  });
});
