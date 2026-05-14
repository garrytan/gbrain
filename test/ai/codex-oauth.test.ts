import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  codexAccessTokenIsExpiring,
  resolveCodexRuntimeCredentials,
  refreshCodexOAuthTokens,
} from '../../src/core/ai/codex-oauth.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeJwt(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, ...extra })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function writeHermesAuth(hermesHome: string, tokens: Record<string, string>): void {
  writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
    version: 1,
    providers: {
      'openai-codex': {
        auth_mode: 'chatgpt',
        tokens,
      },
    },
  }, null, 2));
}

describe('Codex OAuth resolver', () => {
  test('reads Hermes-style auth.json from HERMES_HOME', async () => {
    const hermesHome = tmp('gbrain-codex-hermes-');
    const access = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    writeHermesAuth(hermesHome, { access_token: access, refresh_token: 'refresh_1' });

    const creds = await resolveCodexRuntimeCredentials({ HERMES_HOME: hermesHome });

    expect(creds.provider).toBe('openai-codex');
    expect(creds.accessToken).toBe(access);
    expect(creds.source).toBe('hermes-auth-store');
    expect(creds.refreshed).toBe(false);
  });

  test('missing credentials produces a relogin hint without tokens', async () => {
    const hermesHome = tmp('gbrain-codex-empty-');
    const codexHome = tmp('gbrain-codex-empty-cli-');
    await expect(resolveCodexRuntimeCredentials({ HERMES_HOME: hermesHome, CODEX_HOME: codexHome }))
      .rejects
      .toThrow(AIConfigError);
    try {
      await resolveCodexRuntimeCredentials({ HERMES_HOME: hermesHome, CODEX_HOME: codexHome });
    } catch (e) {
      const err = e as AIConfigError;
      expect(err.fix).toContain('hermes auth');
      expect(err.message).not.toContain('access_token');
      expect(err.message).not.toContain('refresh_token');
    }
  });

  test('refreshes an expiring token and persists rotated tokens to Hermes auth store', async () => {
    const hermesHome = tmp('gbrain-codex-refresh-');
    const oldAccess = fakeJwt(Math.floor(Date.now() / 1000) - 10);
    const newAccess = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    writeHermesAuth(hermesHome, { access_token: oldAccess, refresh_token: 'refresh_old' });

    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      expect(String(init?.body)).not.toContain(oldAccess);
      return new Response(JSON.stringify({
        access_token: newAccess,
        refresh_token: 'refresh_new',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const creds = await resolveCodexRuntimeCredentials(
      { HERMES_HOME: hermesHome },
      { fetchImpl },
    );

    expect(creds.accessToken).toBe(newAccess);
    expect(creds.refreshed).toBe(true);
    const persisted = JSON.parse(readFileSync(join(hermesHome, 'auth.json'), 'utf8'));
    expect(persisted.providers['openai-codex'].tokens.access_token).toBe(newAccess);
    expect(persisted.providers['openai-codex'].tokens.refresh_token).toBe('refresh_new');
  });

  test('does not write refreshed tokens back to Codex CLI fallback auth store', async () => {
    const hermesHome = tmp('gbrain-codex-no-hermes-');
    const codexHome = tmp('gbrain-codex-cli-');
    const oldAccess = fakeJwt(Math.floor(Date.now() / 1000) - 10);
    const newAccess = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: oldAccess, refresh_token: 'refresh_cli' },
    }, null, 2));

    const fetchImpl = (async () => new Response(JSON.stringify({
      access_token: newAccess,
      refresh_token: 'refresh_rotated',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const creds = await resolveCodexRuntimeCredentials(
      { HERMES_HOME: hermesHome, CODEX_HOME: codexHome },
      { fetchImpl },
    );

    expect(creds.accessToken).toBe(newAccess);
    const persisted = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8'));
    expect(persisted.tokens.access_token).toBe(oldAccess);
    expect(persisted.tokens.refresh_token).toBe('refresh_cli');
  });

  test('refresh helper fails cleanly when refresh_token is missing', async () => {
    await expect(refreshCodexOAuthTokens({ access_token: 'x', refresh_token: '' }))
      .rejects
      .toThrow(AIConfigError);
  });

  test('JWT expiry check uses skew window', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(codexAccessTokenIsExpiring(fakeJwt(now + 60), 120)).toBe(true);
    expect(codexAccessTokenIsExpiring(fakeJwt(now + 600), 120)).toBe(false);
  });
});
