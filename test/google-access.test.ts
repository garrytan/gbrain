/**
 * google/access — the non-vault Google access seam (src/core/google/access.ts).
 *
 * parseTokenOutput's parsing table (bare token, JSON token/access_token,
 * expiry/expires_in, and every loud-failure shape), CommandAccessProvider's
 * spawn + cache + forceRefresh semantics (invocation-counted via a temp
 * file the command appends to), and EnvAccessProvider's live-per-call env
 * reads. All tokens are synthetic; env keys are test-scoped and restored via
 * the repo's withEnv helper.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CommandAccessProvider,
  EnvAccessProvider,
  parseTokenOutput,
} from '../src/core/google/access.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import { withEnv } from './helpers/with-env.ts';

/** Run fn and hand back the CredentialError it threw (fails if it didn't). */
async function credErrorFrom(fn: () => unknown | Promise<unknown>): Promise<CredentialError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CredentialError);
    return e as CredentialError;
  }
  throw new Error('expected a CredentialError, got success');
}

// ── parseTokenOutput ─────────────────────────────────────────────────────────

describe('parseTokenOutput', () => {
  test('bare token line round-trips with a null expiry (trailing newline trimmed)', () => {
    expect(parseTokenOutput('tok-abcdef123\n')).toEqual({
      token: 'tok-abcdef123',
      expiresAtMs: null,
    });
  });

  test('JSON with a token field', () => {
    expect(parseTokenOutput('{"token":"tok-abcdef123"}')).toEqual({
      token: 'tok-abcdef123',
      expiresAtMs: null,
    });
  });

  test('JSON with an access_token field (gcloud/gog shape)', () => {
    expect(parseTokenOutput('{"access_token":"ya29.fake-token-xyz"}')).toEqual({
      token: 'ya29.fake-token-xyz',
      expiresAtMs: null,
    });
  });

  test('JSON expiry (ISO string) parses to epoch ms', () => {
    const iso = '2026-09-01T12:00:00.000Z';
    const r = parseTokenOutput(`{"token":"tok-abcdef123","expiry":"${iso}"}`);
    expect(r.token).toBe('tok-abcdef123');
    expect(r.expiresAtMs).toBe(Date.parse(iso));
  });

  test('JSON expires_in (seconds) lands ~now + N seconds', () => {
    const before = Date.now();
    const r = parseTokenOutput('{"token":"tok-abcdef123","expires_in":120}');
    expect(r.expiresAtMs).not.toBeNull();
    expect(r.expiresAtMs!).toBeGreaterThanOrEqual(before + 119_000);
    expect(r.expiresAtMs!).toBeLessThanOrEqual(Date.now() + 121_000);
  });

  test('empty output → access_command_failed', async () => {
    for (const raw of ['', '   \n  ']) {
      const err = await credErrorFrom(() => parseTokenOutput(raw));
      expect(err.code).toBe('access_command_failed');
      expect(err.message).toContain('empty output');
    }
  });

  test('JSON without token/access_token → access_command_failed naming the missing fields', async () => {
    const err = await credErrorFrom(() => parseTokenOutput('{"foo":"bar"}'));
    expect(err.code).toBe('access_command_failed');
    expect(err.message).toContain('no token/access_token');
  });

  test('JSON-looking output that does not parse → access_command_failed', async () => {
    const err = await credErrorFrom(() => parseTokenOutput('{not json at all'));
    expect(err.code).toBe('access_command_failed');
    expect(err.message).toContain('does not parse');
  });

  test('multiline chatty output (log line first) fails loudly, not as a 401', async () => {
    const err = await credErrorFrom(() =>
      parseTokenOutput('Loading credentials from profile...\ntok-abcdef123\n'),
    );
    expect(err.code).toBe('access_command_failed');
    expect(err.message).toContain('does not look like a token');
  });

  test('space-containing or too-short first line → access_command_failed', async () => {
    for (const raw of ['not a token', 'short']) {
      const err = await credErrorFrom(() => parseTokenOutput(raw));
      expect(err.code).toBe('access_command_failed');
      expect(err.message).toContain('does not look like a token');
    }
  });
});

// ── CommandAccessProvider ────────────────────────────────────────────────────

describe('CommandAccessProvider', () => {
  /** A command that appends one byte to `countFile` per invocation, then
   *  emits `output`. Deterministic invocation counting, no timing games. */
  function countedCommand(countFile: string, output: string): string {
    return `printf x >> "${countFile}" && ${output}`;
  }

  function invocations(countFile: string): number {
    return existsSync(countFile) ? readFileSync(countFile, 'utf-8').length : 0;
  }

  test('echo round-trip returns the bare token', async () => {
    const p = new CommandAccessProvider('echo fake-token-abc123');
    expect(await p.getAccessToken()).toBe('fake-token-abc123');
  });

  test('caches until expiry: two getAccessToken calls = one invocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gaccess-cache-'));
    const countFile = join(dir, 'count');
    try {
      const p = new CommandAccessProvider(countedCommand(countFile, 'echo tok-abcdef123'));
      expect(await p.getAccessToken()).toBe('tok-abcdef123');
      expect(await p.getAccessToken()).toBe('tok-abcdef123');
      expect(invocations(countFile)).toBe(1); // default 45-min cache held
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('forceRefresh re-runs the command (invocation counter reaches 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gaccess-refresh-'));
    const countFile = join(dir, 'count');
    try {
      const p = new CommandAccessProvider(countedCommand(countFile, 'echo tok-abcdef123'));
      await p.getAccessToken();
      expect(await p.forceRefresh()).toBe('tok-abcdef123');
      expect(invocations(countFile)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('expires_in: 0 means the cache is already inside the 60s margin — next call re-runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gaccess-expire-'));
    const countFile = join(dir, 'count');
    try {
      const p = new CommandAccessProvider(
        countedCommand(countFile, `printf '{"token":"tok-abcdef123","expires_in":0}'`),
      );
      expect(await p.getAccessToken()).toBe('tok-abcdef123');
      expect(await p.getAccessToken()).toBe('tok-abcdef123');
      expect(invocations(countFile)).toBe(2); // deterministic: no sleep needed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-zero exit → access_command_failed carrying the exit code and the stderr tail', async () => {
    const p = new CommandAccessProvider('echo boom-detail >&2; exit 3');
    const err = await credErrorFrom(() => p.getAccessToken());
    expect(err.code).toBe('access_command_failed');
    expect(err.message).toContain('exit 3');
    expect(err.message).toContain('boom-detail');
  });

  test('empty --token-command is rejected at construction', async () => {
    for (const cmd of ['', '   ']) {
      const err = await credErrorFrom(() => new CommandAccessProvider(cmd));
      expect(err.code).toBe('access_command_failed');
      expect(err.message).toContain('empty --token-command');
    }
  });
});

// ── EnvAccessProvider ────────────────────────────────────────────────────────

const ENV_KEY = 'GBRAIN_TEST_GOOGLE_ACCESS_TOKEN';

describe('EnvAccessProvider', () => {
  test('round-trips the env value', async () => {
    await withEnv({ [ENV_KEY]: 'env-token-abc123' }, async () => {
      const p = new EnvAccessProvider(ENV_KEY);
      expect(await p.getAccessToken()).toBe('env-token-abc123');
    });
  });

  test('unset or blank var → access_env_missing naming the variable', async () => {
    for (const value of [undefined, '   '] as const) {
      await withEnv({ [ENV_KEY]: value }, async () => {
        const p = new EnvAccessProvider(ENV_KEY);
        const err = await credErrorFrom(() => p.getAccessToken());
        expect(err.code).toBe('access_env_missing');
        expect(err.message).toContain(`$${ENV_KEY}`);
      });
    }
  });

  test('reads live each call: forceRefresh (and plain get) see a rotated value', async () => {
    await withEnv({ [ENV_KEY]: 'env-token-one-abc' }, async () => {
      const p = new EnvAccessProvider(ENV_KEY);
      expect(await p.getAccessToken()).toBe('env-token-one-abc');
      // The external refresher rotates the var between calls (nested withEnv
      // keeps the mutation isolation-lint-clean and self-restoring).
      await withEnv({ [ENV_KEY]: 'env-token-two-def' }, async () => {
        expect(await p.forceRefresh()).toBe('env-token-two-def');
        expect(await p.getAccessToken()).toBe('env-token-two-def');
      });
    });
  });

  test('empty --token-env is rejected at construction', async () => {
    const err = await credErrorFrom(() => new EnvAccessProvider(''));
    expect(err.code).toBe('access_env_missing');
    expect(err.message).toContain('empty --token-env');
  });
});
