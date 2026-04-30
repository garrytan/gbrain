import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { resolveOpenClawCodexAuthToken } from '../../src/core/ai/openclaw-auth.ts';
import { configureGateway, resetGateway, isAvailable, getCredentialSource } from '../../src/core/ai/gateway.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-openclaw-auth-'));
}

describe('openclaw auth resolver', () => {
  test('returns null unless opt-in env is enabled', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ access_token: 'sk-test' }));
    expect(resolveOpenClawCodexAuthToken({ GBRAIN_OPENCLAW_AUTH_DIR: dir })).toBeNull();
  });

  test('resolves token from explicit auth path', () => {
    const dir = makeTempDir();
    const path = join(dir, 'codex.json');
    writeFileSync(path, JSON.stringify({ oauth: { access_token: 'sk-codex' } }));
    const resolved = resolveOpenClawCodexAuthToken({
      GBRAIN_OPENCLAW_CODEX_AUTH: '1',
      GBRAIN_OPENCLAW_AUTH_PATH: path,
    });
    expect(resolved?.token).toBe('sk-codex');
    expect(resolved?.profilePath).toBe(path);
  });

  test('resolves token from auth dir candidate path', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    writeFileSync(join(dir, 'profiles', 'codex.json'), JSON.stringify({ tokens: { api_key: 'sk-dir' } }));
    const resolved = resolveOpenClawCodexAuthToken({
      GBRAIN_OPENCLAW_CODEX_AUTH: '1',
      GBRAIN_OPENCLAW_AUTH_DIR: dir,
    });
    expect(resolved?.token).toBe('sk-dir');
  });
});

describe('gateway OpenClaw OpenAI availability', () => {
  test('openai embedding is available via opt-in OpenClaw auth without OPENAI_API_KEY', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ access_token: 'sk-from-openclaw' }));
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: {
        GBRAIN_OPENCLAW_CODEX_AUTH: '1',
        GBRAIN_OPENCLAW_AUTH_DIR: dir,
      },
    });
    expect(isAvailable('embedding')).toBe(true);
    expect(getCredentialSource('openai')).toEqual({ kind: 'openclaw-codex-auth', detail: join(dir, 'auth.json') });
    resetGateway();
  });
});
