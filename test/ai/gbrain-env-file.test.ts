/**
 * Regression: CLI-launched gbrain must be able to discover provider secrets
 * from gbrain's own env file and, when embedded in Hermes workflows, from the
 * Hermes env file where the operator may already keep shared provider keys.
 * loadConfig() itself must remain pure/read-only.
 */

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, loadGbrainEnvFile, loadSharedProviderEnvFiles } from '../../src/core/config.ts';
import { withEnv } from '../helpers/with-env.ts';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function tempEnvFile(prefix: string, lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  const envPath = join(dir, '.env');
  writeFileSync(envPath, lines.join('\n'));
  return envPath;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

test('loadGbrainEnvFile loads dotenv-style keys without overriding env', async () => {
  const envPath = tempEnvFile('gbrain-env-file-', [
    '# comment',
    'export OPENAI_API_KEY=openai-from-file',
    'ANTHROPIC_API_KEY="anthropic-from-file"',
    'BAD KEY=ignored',
    '',
  ]);

  await withEnv({ OPENAI_API_KEY: 'openai-from-env', ANTHROPIC_API_KEY: undefined }, async () => {
    const loaded = loadGbrainEnvFile(envPath);

    expect(process.env.OPENAI_API_KEY).toBe('openai-from-env');
    const anthropic = (process.env as Record<string, string | undefined>)['ANTHROPIC_API_KEY'];
    expect(anthropic).toBe('anthropic-from-file');
    expect(loaded).toEqual(['ANTHROPIC_API_KEY']);
  });
});

test('loadConfig stays read-only even when env files exist', async () => {
  const gbrainHome = tempDir('gbrain-home-');
  const hermesHome = tempDir('hermes-home-');
  const gbrainDir = join(gbrainHome, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });
  writeFileSync(join(gbrainDir, 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: join(gbrainDir, 'brain.db'),
  }));
  writeFileSync(join(gbrainDir, '.env'), 'OPENAI_API_KEY=openai-from-gbrain\n');
  writeFileSync(join(hermesHome, '.env'), 'ANTHROPIC_API_KEY=anthropic-from-hermes\n');

  await withEnv({
    GBRAIN_HOME: gbrainHome,
    HERMES_HOME: hermesHome,
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
  }, async () => {
    const config = loadConfig();

    expect(config?.openai_api_key).toBeUndefined();
    expect(config?.anthropic_api_key).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

test('loadSharedProviderEnvFiles bridges Hermes provider keys with narrow precedence', async () => {
  const gbrainEnvPath = tempEnvFile('gbrain-provider-env-', [
    'OPENAI_API_KEY=openai-from-gbrain',
    'ANTHROPIC_API_KEY=anthropic-from-gbrain',
  ]);
  const hermesEnvPath = tempEnvFile('hermes-provider-env-', [
    'OPENAI_API_KEY=openai-from-hermes',
    'ANTHROPIC_API_KEY=anthropic-from-hermes',
    'VOYAGE_API_KEY=voyage-from-hermes',
    'TELEGRAM_BOT_TOKEN=not-shared-with-gbrain',
  ]);

  await withEnv({
    OPENAI_API_KEY: 'openai-from-process',
    ANTHROPIC_API_KEY: undefined,
    VOYAGE_API_KEY: undefined,
    TELEGRAM_BOT_TOKEN: undefined,
  }, async () => {
    const loaded = loadSharedProviderEnvFiles({ gbrainEnvPath, hermesEnvPath });

    expect(process.env.OPENAI_API_KEY).toBe('openai-from-process');
    expect(process.env.ANTHROPIC_API_KEY).toBe('anthropic-from-gbrain');
    expect(process.env.VOYAGE_API_KEY).toBe('voyage-from-hermes');
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(loaded).toEqual([
      { source: 'gbrain', path: gbrainEnvPath, keys: ['ANTHROPIC_API_KEY'] },
      { source: 'hermes', path: hermesEnvPath, keys: ['VOYAGE_API_KEY'] },
    ]);
  });
});
