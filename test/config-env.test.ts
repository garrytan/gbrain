import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { loadConfig, saveConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

// PR #681 originally shipped a manual `restoreEnv()` in afterEach for these
// tests. CLAUDE.md R1 (test-isolation lint) and the codex outside-voice
// review (D3 in the v0.31 plan) called that out — manual try/restore patterns
// don't survive an assertion failure mid-test, the codemod for parallel
// test execution can't whitelist them, and the canonical helper at
// test/helpers/with-env.ts already exists for this. Migrating here.
//
// withEnv()'s try/finally restores even when the callback throws, so a
// failed expect() inside the block leaves the process env clean for the
// next file in the shard.

describe('loadConfig env database URL precedence', () => {
  test('DATABASE_URL switches an existing PGLite file config to Postgres', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-env-'));
    try {
      // Pre-seed: PGLite file config in this isolated GBRAIN_HOME.
      await withEnv(
        { GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined },
        () => {
          saveConfig({ engine: 'pglite', database_path: '/tmp/local-brain.pglite' });
        },
      );

      // DATABASE_URL set: loadConfig must override PGLite selection,
      // pick Postgres, and clear the stale database_path so toEngineConfig
      // doesn't try to use both.
      await withEnv(
        {
          GBRAIN_HOME: home,
          GBRAIN_DATABASE_URL: undefined,
          DATABASE_URL: 'postgres://user:pass@example.test:5432/gbrain',
        },
        () => {
          const cfg = loadConfig();
          expect(cfg?.engine).toBe('postgres');
          expect(cfg?.database_url).toBe('postgres://user:pass@example.test:5432/gbrain');
          expect(cfg?.database_path).toBeUndefined();
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('GBRAIN_DATABASE_URL beats DATABASE_URL (operator override)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-env-'));
    try {
      await withEnv(
        { GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined },
        () => {
          saveConfig({ engine: 'pglite', database_path: '/tmp/local-brain.pglite' });
        },
      );

      await withEnv(
        {
          GBRAIN_HOME: home,
          GBRAIN_DATABASE_URL: 'postgres://win:win@gbrain.test:5432/db',
          DATABASE_URL: 'postgres://lose:lose@other.test:5432/db',
        },
        () => {
          const cfg = loadConfig();
          expect(cfg?.engine).toBe('postgres');
          expect(cfg?.database_url).toBe('postgres://win:win@gbrain.test:5432/db');
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('No env DB URL → existing PGLite file config is honored', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-env-'));
    try {
      await withEnv(
        { GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined },
        () => {
          saveConfig({ engine: 'pglite', database_path: '/tmp/local-brain.pglite' });
          const cfg = loadConfig();
          expect(cfg?.engine).toBe('pglite');
          expect(cfg?.database_path).toBe('/tmp/local-brain.pglite');
          expect(cfg?.database_url).toBeUndefined();
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('No file config + DATABASE_URL → infers Postgres', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-env-'));
    try {
      await withEnv(
        {
          GBRAIN_HOME: home,
          GBRAIN_DATABASE_URL: undefined,
          DATABASE_URL: 'postgres://only:env@gbrain.test:5432/db',
        },
        () => {
          // No saveConfig() — no file present at all.
          const cfg = loadConfig();
          expect(cfg?.engine).toBe('postgres');
          expect(cfg?.database_url).toBe('postgres://only:env@gbrain.test:5432/db');
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('No file config + no env DB URL → loadConfig returns null', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-env-'));
    try {
      await withEnv(
        { GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined },
        () => {
          expect(loadConfig()).toBeNull();
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
