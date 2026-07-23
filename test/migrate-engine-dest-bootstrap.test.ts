import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { bootstrapDestinationConfig } from '../src/commands/migrate-engine.ts';
import { loadConfigFileOnly } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

describe('migrate --to pglite destination bootstrap (#1271)', () => {
  test('writes <path>/.gbrain/config.json so GBRAIN_HOME=<path> resolves a brain', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'gbrain-dest-'));
    const written = bootstrapDestinationConfig(dest);
    const file = join(dest, '.gbrain', 'config.json');
    expect(written).toBe(file);

    const cfg = JSON.parse(readFileSync(file, 'utf-8'));
    expect(cfg.engine).toBe('pglite');
    expect(cfg.database_path).toBe(resolve(dest));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // worktree safety: destination home is git-ignored like saveConfig()'s home
    expect(readFileSync(join(dest, '.gbrain', '.gitignore'), 'utf-8')).toBe('*\n');

    // The exact failure mode from #1271: config resolution under
    // GBRAIN_HOME=<path> used to find nothing ("No brain configured").
    await withEnv({ GBRAIN_HOME: dest }, () => {
      const loaded = loadConfigFileOnly();
      expect(loaded?.engine).toBe('pglite');
      expect(loaded?.database_path).toBe(resolve(dest));
    });
  });

  test('never clobbers an existing destination config', () => {
    const dest = mkdtempSync(join(tmpdir(), 'gbrain-dest-'));
    mkdirSync(join(dest, '.gbrain'), { recursive: true });
    writeFileSync(join(dest, '.gbrain', 'config.json'), '{"engine":"postgres"}\n');

    expect(bootstrapDestinationConfig(dest)).toBe(null);
    expect(JSON.parse(readFileSync(join(dest, '.gbrain', 'config.json'), 'utf-8')).engine).toBe('postgres');
  });
});
