import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureConfigOverwriteAllowed } from '../src/commands/init.ts';
import { MBrainError } from '../src/core/types.ts';

describe('ensureConfigOverwriteAllowed', () => {
  let tempDir: string;
  let configFile: string;
  let prevConfigPath: string | undefined;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mbrain-init-guard-'));
    configFile = join(tempDir, 'config.json');
    prevConfigPath = process.env.MBRAIN_CONFIG_PATH;
    prevConfigDir = process.env.MBRAIN_CONFIG_DIR;
    process.env.MBRAIN_CONFIG_PATH = configFile;
    delete process.env.MBRAIN_CONFIG_DIR;
  });

  afterEach(() => {
    if (prevConfigPath === undefined) delete process.env.MBRAIN_CONFIG_PATH;
    else process.env.MBRAIN_CONFIG_PATH = prevConfigPath;
    if (prevConfigDir === undefined) delete process.env.MBRAIN_CONFIG_DIR;
    else process.env.MBRAIN_CONFIG_DIR = prevConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const postgresTarget = {
    engine: 'postgres' as const,
    database_url: 'postgresql://meghendra@localhost:54322/mbrain',
  };

  function backupFiles(): string[] {
    return readdirSync(tempDir).filter((f) => f.startsWith('config.json.bak-'));
  }

  test('allows init when no config exists, without creating a backup', () => {
    const result = ensureConfigOverwriteAllowed(postgresTarget, { force: false });
    expect(result.backedUpTo).toBeNull();
    expect(backupFiles().length).toBe(0);
  });

  test('allows re-init to the same target and creates a backup', () => {
    writeFileSync(configFile, JSON.stringify({
      engine: 'postgres',
      database_url: 'postgresql://meghendra@localhost:54322/mbrain',
    }));
    const result = ensureConfigOverwriteAllowed(postgresTarget, { force: false });
    expect(result.backedUpTo).not.toBeNull();
    expect(existsSync(result.backedUpTo!)).toBe(true);
    expect(backupFiles().length).toBe(1);
  });

  test('refuses to overwrite a config pointing at a different database without --force', () => {
    writeFileSync(configFile, JSON.stringify({
      engine: 'postgres',
      database_url: 'postgresql://postgres:postgres@localhost:5435/mbrain_test',
    }));
    expect(() => ensureConfigOverwriteAllowed(postgresTarget, { force: false }))
      .toThrow(MBrainError);
    expect(backupFiles().length).toBe(0);
  });

  test('refusal message mentions --force and the existing target', () => {
    writeFileSync(configFile, JSON.stringify({
      engine: 'postgres',
      database_url: 'postgresql://postgres:postgres@localhost:5435/mbrain_test',
    }));
    let message = '';
    try {
      ensureConfigOverwriteAllowed(postgresTarget, { force: false });
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('--force');
    expect(message).toContain('localhost:5435/mbrain_test');
  });

  test('overwrites a different target with --force and preserves the old content in a backup', () => {
    const original = JSON.stringify({
      engine: 'postgres',
      database_url: 'postgresql://postgres:postgres@localhost:5435/mbrain_test',
    });
    writeFileSync(configFile, original);
    const result = ensureConfigOverwriteAllowed(postgresTarget, { force: true });
    expect(result.backedUpTo).not.toBeNull();
    expect(readFileSync(result.backedUpTo!, 'utf-8')).toBe(original);
  });

  test('treats engine changes as a different target', () => {
    writeFileSync(configFile, JSON.stringify({
      engine: 'sqlite',
      database_path: '/tmp/brain.db',
    }));
    expect(() => ensureConfigOverwriteAllowed(postgresTarget, { force: false }))
      .toThrow(MBrainError);
  });

  test('treats an unparseable existing config as a different target', () => {
    writeFileSync(configFile, 'not json{');
    expect(() => ensureConfigOverwriteAllowed(postgresTarget, { force: false }))
      .toThrow(MBrainError);
    const result = ensureConfigOverwriteAllowed(postgresTarget, { force: true });
    expect(result.backedUpTo).not.toBeNull();
  });

  test('fence: every CLI init spawn in the E2E suites isolates the MBrain config dir', () => {
    // The 2026-06-12 incident: mechanical.test.ts spawned `mbrain init` with the
    // user's real environment, repointing ~/.mbrain/config.json at a throwaway
    // test database. Every E2E file that invokes `init` via the CLI must set
    // MBRAIN_CONFIG_DIR (or MBRAIN_CONFIG_PATH / HOME) to an isolated location.
    const source = readFileSync(
      new URL('./e2e/mechanical.test.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toContain('MBRAIN_CONFIG_DIR');
  });

  test('infers the engine of legacy configs without an engine field', () => {
    // Legacy config with database_path and no engine infers pglite, not postgres.
    writeFileSync(configFile, JSON.stringify({ database_path: '/tmp/brain.pglite' }));
    expect(() => ensureConfigOverwriteAllowed(postgresTarget, { force: false }))
      .toThrow(MBrainError);
    expect(() => ensureConfigOverwriteAllowed(
      { engine: 'pglite', database_path: '/tmp/brain.pglite' },
      { force: false },
    )).not.toThrow();
  });
});

describe('review fixes: DSN sanitization and backup pruning', () => {
  let tempDir: string;
  let configFile: string;
  let prevConfigPath: string | undefined;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mbrain-init-guard2-'));
    configFile = join(tempDir, 'config.json');
    prevConfigPath = process.env.MBRAIN_CONFIG_PATH;
    prevConfigDir = process.env.MBRAIN_CONFIG_DIR;
    process.env.MBRAIN_CONFIG_PATH = configFile;
    delete process.env.MBRAIN_CONFIG_DIR;
  });

  afterEach(() => {
    if (prevConfigPath === undefined) delete process.env.MBRAIN_CONFIG_PATH;
    else process.env.MBRAIN_CONFIG_PATH = prevConfigPath;
    if (prevConfigDir === undefined) delete process.env.MBRAIN_CONFIG_DIR;
    else process.env.MBRAIN_CONFIG_DIR = prevConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('refusal message never contains database passwords', () => {
    writeFileSync(configFile, JSON.stringify({
      engine: 'postgres',
      database_url: 'postgresql://olduser:OLDSECRET@localhost:5435/mbrain_test',
    }));
    let message = '';
    try {
      ensureConfigOverwriteAllowed(
        { engine: 'postgres', database_url: 'postgresql://newuser:NEWSECRET@localhost:54322/mbrain' },
        { force: false },
      );
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('localhost:5435');
    expect(message).toContain('localhost:54322');
    expect(message).not.toContain('OLDSECRET');
    expect(message).not.toContain('NEWSECRET');
  });

  test('keeps only the newest backups when re-init runs repeatedly', () => {
    const target = {
      engine: 'postgres' as const,
      database_url: 'postgresql://meghendra@localhost:54322/mbrain',
    };
    writeFileSync(configFile, JSON.stringify({ engine: 'postgres', database_url: target.database_url }));
    for (let i = 0; i < 8; i++) {
      const result = ensureConfigOverwriteAllowed(target, { force: false });
      expect(result.backedUpTo).not.toBeNull();
      // Distinct timestamps so the prune-by-name ordering is deterministic.
      Bun.sleepSync(2);
    }
    const backups = readdirSync(tempDir).filter((f) => f.startsWith('config.json.bak-'));
    expect(backups.length).toBeLessThanOrEqual(5);
  });
});
