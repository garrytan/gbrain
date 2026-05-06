import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig, saveConfig } from '../src/core/config.ts';

const ORIG_GBRAIN_HOME = process.env.GBRAIN_HOME;
const ORIG_DATABASE_URL = process.env.DATABASE_URL;
const ORIG_GBRAIN_DATABASE_URL = process.env.GBRAIN_DATABASE_URL;

function restoreEnv() {
  if (ORIG_GBRAIN_HOME === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
  if (ORIG_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIG_DATABASE_URL;
  if (ORIG_GBRAIN_DATABASE_URL === undefined) delete process.env.GBRAIN_DATABASE_URL;
  else process.env.GBRAIN_DATABASE_URL = ORIG_GBRAIN_DATABASE_URL;
}

afterEach(() => {
  restoreEnv();
});

describe('loadConfig env database URL precedence', () => {
  test('DATABASE_URL switches an existing PGLite file config to Postgres', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-env-'));
    process.env.GBRAIN_HOME = home;
    delete process.env.GBRAIN_DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      saveConfig({ engine: 'pglite', database_path: '/tmp/local-brain.pglite' });
      process.env.DATABASE_URL = 'postgres://user:pass@example.test:5432/gbrain';

      const cfg = loadConfig();
      expect(cfg?.engine).toBe('postgres');
      expect(cfg?.database_url).toBe('postgres://user:pass@example.test:5432/gbrain');
      expect(cfg?.database_path).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
