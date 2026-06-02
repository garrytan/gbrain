import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'path';

import {
  chat,
  configureGateway,
  isAvailable,
  probeChatModel,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import {
  codexAuthAvailable,
  codexAuthFailureDetail,
  resolveCodexAuthSnapshot,
  type CodexAuthResolveOptions,
} from '../../src/core/ai/codex-auth.ts';

const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOME = '/fixture-home';
const CODEX_PATH = join(HOME, '.codex', 'auth.json');
const HERMES_PATH = join(HOME, '.hermes', 'codex-auth.json');
const OPENAI_CODEX_ACCESS_TOKEN = 'OPENAI_CODEX_ACCESS_TOKEN';

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function jwt(expSeconds: number, extraPayload: Record<string, unknown> = {}): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: 'acct_fixture', exp: expSeconds, ...extraPayload })}.sig`;
}

const VALID_TOKEN = jwt(Date.UTC(2030, 0, 1, 0, 0, 0) / 1000);
const EXPIRED_TOKEN = jwt(Math.floor(NOW_MS / 1000) - 60);

function readerFrom(files: Record<string, string>): NonNullable<CodexAuthResolveOptions['readFileText']> {
  return (path) => {
    if (Object.prototype.hasOwnProperty.call(files, path)) return files[path]!;
    throw new Error(`fixture auth file not found: ${path}`);
  };
}

function missingReader(seen: string[] = []): NonNullable<CodexAuthResolveOptions['readFileText']> {
  return (path) => {
    seen.push(path);
    throw new Error(`fixture auth file not found: ${path}`);
  };
}

function authFixture(token = VALID_TOKEN, expiresAtMs = NOW_MS + 3_600_000): string {
  return JSON.stringify({
    access_token: token,
    access_token_expires_at: expiresAtMs,
    refresh_token: 'refresh-token-must-not-appear-in-snapshots',
    account_id: 'acct_fixture',
  });
}

function expectFailureRedacted(snapshot: ReturnType<typeof resolveCodexAuthSnapshot>, secret: string): void {
  expect(snapshot.ok).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain(secret);
  expect(codexAuthFailureDetail(snapshot)).not.toContain(secret);
}

afterEach(() => {
  resetGateway();
});

describe('resolveCodexAuthSnapshot', () => {
  test('auto uses fixture read seam and never touches real local credential paths', () => {
    const seen: string[] = [];
    const snapshot = resolveCodexAuthSnapshot({
      homeDir: HOME,
      env: {},
      now: NOW_MS,
      readFileText: (path) => {
        seen.push(path);
        return authFixture();
      },
    });

    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.source).toBe('codex-cli');
      expect(snapshot.accountId).toBe('acct_fixture');
      expect(JSON.stringify(snapshot)).not.toContain('refresh-token-must-not-appear-in-snapshots');
      expect(JSON.stringify(snapshot)).not.toContain(VALID_TOKEN);
      expect(JSON.stringify(snapshot)).not.toContain('acct_fixture');
      expect(Object.isFrozen(snapshot)).toBe(true);
    }
    expect(seen).toEqual([CODEX_PATH]);
  });

  test('auto source order is codex-cli file, then hermes file, then env token', () => {
    const codexWins = resolveCodexAuthSnapshot({
      homeDir: HOME,
      env: { [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN },
      now: NOW_MS,
      readFileText: readerFrom({
        [CODEX_PATH]: authFixture(VALID_TOKEN, NOW_MS + 1_000),
        [HERMES_PATH]: authFixture(jwt(Math.floor(NOW_MS / 1000) + 7200), NOW_MS + 2_000),
      }),
    });
    expect(codexWins.ok && codexWins.source).toBe('codex-cli');

    const hermesWins = resolveCodexAuthSnapshot({
      homeDir: HOME,
      env: { [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN },
      now: NOW_MS,
      readFileText: readerFrom({
        [HERMES_PATH]: authFixture(VALID_TOKEN, NOW_MS + 2_000),
      }),
    });
    expect(hermesWins.ok && hermesWins.source).toBe('hermes');

    const envWins = resolveCodexAuthSnapshot({
      homeDir: HOME,
      env: { [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN },
      now: NOW_MS,
      readFileText: missingReader(),
    });
    expect(envWins.ok && envWins.source).toBe('env');
  });

  test('missing local files and missing env token fail closed with redacted unavailable code', () => {
    const seen: string[] = [];
    const snapshot = resolveCodexAuthSnapshot({
      homeDir: HOME,
      env: {},
      now: NOW_MS,
      readFileText: missingReader(seen),
    });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.code).toBe('unavailable');
      expect(snapshot.message).toContain('auth file not found');
      expect(snapshot.message).not.toContain(HOME);
      expect(snapshot.checkedPaths).toContain(CODEX_PATH);
    }
    expect(seen).toEqual([CODEX_PATH, HERMES_PATH]);
  });

  test('expired JWTs fail with stable expired code without leaking token text', () => {
    const snapshot = resolveCodexAuthSnapshot({
      source: 'env',
      env: { [OPENAI_CODEX_ACCESS_TOKEN]: EXPIRED_TOKEN },
      now: NOW_MS,
    });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.source).toBe('env');
      expect(snapshot.code).toBe('expired');
      expect(snapshot.message).toContain('expired');
    }
    expectFailureRedacted(snapshot, EXPIRED_TOKEN);
  });

  test('explicit gbrain-oauth source is unsupported and fails closed', () => {
    const snapshot = resolveCodexAuthSnapshot({
      source: 'gbrain-oauth',
      env: { [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN },
      now: NOW_MS,
      readFileText: () => {
        throw new Error('must not read files for unsupported source');
      },
    });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.source).toBe('gbrain-oauth');
      expect(snapshot.code).toBe('unsupported_source');
      expect(snapshot.message).toContain('unsupported');
    }
  });

  test('empty and invalid auth files fail with stable redacted unavailable messages', () => {
    const empty = resolveCodexAuthSnapshot({
      source: 'codex-cli',
      codexAuthPath: CODEX_PATH,
      env: {},
      now: NOW_MS,
      readFileText: () => '   ',
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe('unavailable');
      expect(empty.message).toContain('auth file is empty');
    }

    const invalid = resolveCodexAuthSnapshot({
      source: 'codex-cli',
      codexAuthPath: CODEX_PATH,
      env: {},
      now: NOW_MS,
      readFileText: () => `{ "access_token": "leaky-token-in-invalid-json"`,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.code).toBe('unavailable');
      expect(invalid.message).toContain('not valid JSON');
    }
    expectFailureRedacted(invalid, 'leaky-token-in-invalid-json');
  });

  test('invalid non-JWT env token fails redacted instead of falling back to public OpenAI key', () => {
    const leaky = 'leaky-secret-token-without-expiry';
    const invalid = resolveCodexAuthSnapshot({
      source: 'env',
      env: {
        OPENAI_API_KEY: 'sk-public-openai-must-not-count',
        [OPENAI_CODEX_ACCESS_TOKEN]: leaky,
      },
      now: NOW_MS,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.source).toBe('env');
      expect(invalid.code).toBe('unavailable');
      expect(invalid.message).toContain('missing local expiry hint');
    }
    expectFailureRedacted(invalid, leaky);

    const publicOpenAIOnly = resolveCodexAuthSnapshot({
      source: 'env',
      env: { OPENAI_API_KEY: 'sk-public-openai-must-not-count' },
      now: NOW_MS,
    });
    expect(publicOpenAIOnly.ok).toBe(false);
    expectFailureRedacted(publicOpenAIOnly, 'sk-public-openai-must-not-count');
  });

  test('env token fallback succeeds when local fixtures are missing and token has a valid JWT exp', () => {
    const snapshot = resolveCodexAuthSnapshot({
      homeDir: HOME,
      env: { [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN },
      now: NOW_MS,
      readFileText: missingReader(),
    });

    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.source).toBe('env');
      expect(snapshot.accessToken).toBe(VALID_TOKEN);
      expect(JSON.stringify(snapshot)).not.toContain(VALID_TOKEN);
      expect(snapshot.expiresAtMs).toBeGreaterThan(NOW_MS);
    }
  });

  test('auto fails closed when a local auth file declares reserved gbrain-oauth source', () => {
    const snapshot = resolveCodexAuthSnapshot({
      homeDir: HOME,
      env: { [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN },
      now: NOW_MS,
      readFileText: readerFrom({
        [CODEX_PATH]: JSON.stringify({ source: 'gbrain-oauth', access_token: VALID_TOKEN }),
      }),
    });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.source).toBe('gbrain-oauth');
      expect(snapshot.code).toBe('unsupported_source');
    }
    expectFailureRedacted(snapshot, VALID_TOKEN);
  });

  test('codexAuthAvailable rejects stale ok snapshots defensively', () => {
    expect(codexAuthAvailable({
      ok: true,
      source: 'env',
      accessToken: VALID_TOKEN,
      tokenType: 'bearer',
      expiresAtMs: NOW_MS - 1,
      expiresAt: new Date(NOW_MS - 1).toISOString(),
    })).toBe(false);
  });
});

describe('gateway Codex auth snapshot', () => {
  test('configureGateway materializes snapshot for availability, probe, and pending transport error', async () => {
    const env: Record<string, string | undefined> = { [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN };
    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env,
      codex_auth_options: {
        homeDir: HOME,
        now: NOW_MS,
        readFileText: missingReader(),
      },
    });

    delete env[OPENAI_CODEX_ACCESS_TOKEN];

    expect(isAvailable('chat', 'openai-codex:gpt-5.5')).toBe(true);
    expect(probeChatModel('openai-codex:gpt-5.5')).toEqual({ ok: true });

    await expect(chat({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
    })).rejects.toThrow(/Codex Responses streaming transport is pending/);
  });

  test('Codex chat availability and probe are false with missing snapshot', () => {
    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env: { OPENAI_API_KEY: 'sk-public-openai-must-not-count' },
      codex_auth_options: {
        homeDir: HOME,
        now: NOW_MS,
        readFileText: missingReader(),
      },
    });

    expect(isAvailable('chat', 'openai-codex:gpt-5.5')).toBe(false);
    const probe = probeChatModel('openai-codex:gpt-5.5');
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.reason).toBe('unavailable');
      expect(probe.detail).toContain('Codex auth unavailable');
      expect(probe.detail).not.toContain('sk-public-openai-must-not-count');
    }
  });
});
