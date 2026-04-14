import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hasOpenAICredentials, resolveOpenAICredentials } from '../src/core/openai-credentials.ts';

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

function withTempHome(run: (homeDir: string) => void) {
  const homeDir = mkdtempSync(join(tmpdir(), 'gbrain-openai-creds-'));
  try {
    run(homeDir);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('resolveOpenAICredentials', () => {
  test('prefers OPENAI_API_KEY from env over oauth stores', () => {
    withTempHome((homeDir) => {
      mkdirSync(join(homeDir, '.hermes'), { recursive: true });
      writeFileSync(join(homeDir, '.hermes', 'auth.json'), JSON.stringify({
        version: 1,
        providers: {
          'openai-codex': {
            tokens: {
              access_token: 'oauth-access',
              refresh_token: 'oauth-refresh',
            },
          },
        },
      }));

      const creds = resolveOpenAICredentials({
        env: {
          OPENAI_API_KEY: 'sk-test',
          OPENAI_BASE_URL: 'https://api.openai.com/v1/',
        },
        homeDir,
      });

      expect(creds).toEqual({
        apiKey: 'sk-test',
        baseURL: 'https://api.openai.com/v1',
        source: 'env',
        authMode: 'api-key',
      });
    });
  });

  test('falls back to Hermes openai-codex auth store', () => {
    withTempHome((homeDir) => {
      mkdirSync(join(homeDir, '.hermes'), { recursive: true });
      writeFileSync(join(homeDir, '.hermes', 'auth.json'), JSON.stringify({
        version: 1,
        providers: {
          'openai-codex': {
            tokens: {
              access_token: 'oauth-access',
              refresh_token: 'oauth-refresh',
            },
            auth_mode: 'chatgpt',
          },
        },
      }));

      const creds = resolveOpenAICredentials({ env: {}, homeDir });

      expect(creds).toEqual({
        apiKey: 'oauth-access',
        baseURL: DEFAULT_CODEX_BASE_URL,
        source: 'hermes-auth-store',
        authMode: 'chatgpt',
      });
      expect(hasOpenAICredentials({ env: {}, homeDir })).toBe(true);
    });
  });

  test('falls back to Codex CLI auth.json when Hermes auth is absent', () => {
    withTempHome((homeDir) => {
      const codexHome = join(homeDir, 'custom-codex-home');
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({
        tokens: {
          access_token: 'cli-access',
          refresh_token: 'cli-refresh',
        },
      }));

      const creds = resolveOpenAICredentials({
        env: { CODEX_HOME: codexHome },
        homeDir,
      });

      expect(creds).toEqual({
        apiKey: 'cli-access',
        baseURL: DEFAULT_CODEX_BASE_URL,
        source: 'codex-cli',
        authMode: 'chatgpt',
      });
    });
  });

  test('returns null when no env key or oauth tokens exist', () => {
    withTempHome((homeDir) => {
      expect(resolveOpenAICredentials({ env: {}, homeDir })).toBeNull();
      expect(hasOpenAICredentials({ env: {}, homeDir })).toBe(false);
    });
  });
});
