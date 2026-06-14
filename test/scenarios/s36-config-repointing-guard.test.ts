/**
 * Scenario S36 - Config repointing guard.
 *
 * Replays E-29, the 2026-06-12 P0 incident where a CLI init run could repoint
 * an existing user config at a different local database. The scenario uses
 * isolated HOME and MBRAIN_CONFIG_DIR values so it can never touch real user
 * config.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '../..');

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function spawnInit(args: string[], env: Record<string, string | undefined>) {
  return Bun.spawnSync({
    cmd: ['bun', 'run', 'src/cli.ts', 'init', ...args],
    cwd: repoRoot,
    env,
    timeout: 20_000,
  });
}

describe('S36 - config repointing guard', () => {
  test('init --local refuses a different database without --force, then backs up and updates with --force', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mbrain-s36-config-repointing-'));

    try {
      const homeDir = join(rootDir, 'home');
      const configDir = join(rootDir, 'config');
      const configFile = join(configDir, 'config.json');
      const oldDbPath = join(rootDir, 'old.sqlite');
      const newDbPath = join(rootDir, 'new.sqlite');
      const existingBackupName = 'config.json.bak-existing';
      const existingBackupPath = join(configDir, existingBackupName);
      const oldDbText = 'old-db-sentinel\n';
      const existingBackupText = 'preexisting-backup-sentinel\n';

      mkdirSync(homeDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });

      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: homeDir,
        MBRAIN_CONFIG_DIR: configDir,
      };
      delete env.MBRAIN_CONFIG_PATH;
      delete env.MBRAIN_DATABASE_PATH;
      delete env.MBRAIN_DATABASE_URL;
      delete env.DATABASE_URL;

      const originalConfig = {
        engine: 'sqlite',
        database_path: oldDbPath,
        offline: true,
        embedding_provider: 'local',
        query_rewrite_provider: 'heuristic',
      };
      const originalConfigText = `${JSON.stringify(originalConfig, null, 2)}\n`;
      writeFileSync(configFile, originalConfigText, 'utf-8');
      writeFileSync(oldDbPath, oldDbText, 'utf-8');
      writeFileSync(existingBackupPath, existingBackupText, 'utf-8');

      const refused = spawnInit(['--local', '--path', newDbPath], env);
      const refusedStderr = decode(refused.stderr);

      expect(refused.exitCode).not.toBe(0);
      expect(refusedStderr).toContain('Refusing to overwrite existing config');
      expect(refusedStderr).toContain('--force');
      expect(readFileSync(configFile, 'utf-8')).toBe(originalConfigText);
      expect(readFileSync(oldDbPath, 'utf-8')).toBe(oldDbText);
      expect(existsSync(newDbPath)).toBe(false);
      expect(readdirSync(configDir).filter((name) => name.startsWith('config.json.bak-'))).toEqual([
        existingBackupName,
      ]);
      expect(readFileSync(existingBackupPath, 'utf-8')).toBe(existingBackupText);

      const forced = spawnInit(['--local', '--path', newDbPath, '--force'], env);
      const forcedStderr = decode(forced.stderr);

      expect(forced.exitCode).toBe(0);
      expect(forcedStderr).toBe('');

      const updatedConfig = JSON.parse(readFileSync(configFile, 'utf-8'));
      expect(updatedConfig.engine).toBe('sqlite');
      expect(updatedConfig.database_path).toBe(newDbPath);
      expect(existsSync(newDbPath)).toBe(true);

      const backups = readdirSync(configDir)
        .filter((name) => name.startsWith('config.json.bak-'))
        .sort();
      expect(backups).toContain(existingBackupName);
      expect(readFileSync(existingBackupPath, 'utf-8')).toBe(existingBackupText);

      const forcedBackups = backups.filter((name) => name !== existingBackupName);
      expect(forcedBackups.length).toBe(1);
      expect(readFileSync(join(configDir, forcedBackups[0]!), 'utf-8')).toBe(originalConfigText);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
