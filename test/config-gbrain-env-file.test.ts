/**
 * ~/.gbrain/.env secrets loader (#3893, reimplemented from @y2688's PR).
 *
 * Bun only auto-loads `.env` from the process cwd, which for a globally
 * installed CLI is arbitrary — and cwd .env files are UNTRUSTED input (the
 * #427 DATABASE_URL-hijack guard in config.ts exists because of them). The
 * gbrain home is operator-owned, so `~/.gbrain/.env` is the deliberate spot
 * for API keys that must stay OUT of config.json. loadConfig() fills
 * process.env from it; a variable the shell already exported always wins.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { loadConfig, saveConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * Fresh isolated GBRAIN_HOME with a minimal PGLite config.json (so
 * loadConfig() returns a config object) and the given ~/.gbrain/.env body.
 * The `env` overrides ride through withEnv so every key the loader might
 * set is restored after the callback — including keys the loader itself
 * writes into process.env.
 */
async function withEnvFile<T>(
  envFileBody: string | null,
  env: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-env-file-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, ...env }, async () => {
      saveConfig({ engine: 'pglite', database_path: join(home, 'brain.pglite') });
      if (envFileBody !== null) {
        mkdirSync(join(home, '.gbrain'), { recursive: true });
        writeFileSync(join(home, '.gbrain', '.env'), envFileBody, 'utf-8');
      }
      return await fn();
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('loadConfig — ~/.gbrain/.env secrets file (#3893)', () => {
  test('a key in ~/.gbrain/.env reaches process.env and the merged config', async () => {
    await withEnvFile(
      'OPENAI_API_KEY=sk-envfile-123\n',
      { OPENAI_API_KEY: undefined },
      () => {
        const cfg = loadConfig();
        expect(process.env.OPENAI_API_KEY).toBe('sk-envfile-123');
        expect(cfg?.openai_api_key).toBe('sk-envfile-123');
      },
    );
  });

  test('a shell-exported variable wins over the .env file value', async () => {
    await withEnvFile(
      'OPENAI_API_KEY=sk-envfile-loser\n',
      { OPENAI_API_KEY: 'sk-shell-winner' },
      () => {
        const cfg = loadConfig();
        expect(process.env.OPENAI_API_KEY).toBe('sk-shell-winner');
        expect(cfg?.openai_api_key).toBe('sk-shell-winner');
      },
    );
  });

  test('quoted values are unwrapped; unquoted values drop trailing inline comments', async () => {
    await withEnvFile(
      [
        'ANTHROPIC_API_KEY="sk-quoted-value"',
        "OPENROUTER_API_KEY='sk-single-quoted'",
        'ZEROENTROPY_API_KEY=sk-inline # trailing comment',
        '',
      ].join('\n'),
      {
        ANTHROPIC_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        ZEROENTROPY_API_KEY: undefined,
      },
      () => {
        loadConfig();
        expect(process.env.ANTHROPIC_API_KEY).toBe('sk-quoted-value');
        expect(process.env.OPENROUTER_API_KEY).toBe('sk-single-quoted');
        expect(process.env.ZEROENTROPY_API_KEY).toBe('sk-inline');
      },
    );
  });

  test('comments, blank lines, malformed lines, and empty values never land', async () => {
    await withEnvFile(
      [
        '# a full-line comment',
        '',
        '=no-key-name',
        'not a assignment line',
        'GBRAIN_TEST_ENV_FILE_EMPTY=',
        'GBRAIN_TEST_ENV_FILE_OK=yes',
        '',
      ].join('\n'),
      {
        GBRAIN_TEST_ENV_FILE_EMPTY: undefined,
        GBRAIN_TEST_ENV_FILE_OK: undefined,
      },
      () => {
        // Must not throw on the junk lines.
        expect(loadConfig()).not.toBeNull();
        expect(process.env.GBRAIN_TEST_ENV_FILE_EMPTY).toBeUndefined();
        expect(process.env.GBRAIN_TEST_ENV_FILE_OK).toBe('yes');
      },
    );
  });

  test('a missing ~/.gbrain/.env is not an error', async () => {
    await withEnvFile(null, {}, () => {
      const cfg = loadConfig();
      expect(cfg?.engine).toBe('pglite');
    });
  });
});
