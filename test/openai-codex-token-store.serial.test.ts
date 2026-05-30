import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { mkdtemp, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  KeychainTokenStore,
  FileTokenStore,
  InMemoryTokenStore,
  redactTokenLike,
  tokenCredentialPath,
  type OpenAICodexTokenRecord,
} from '../src/core/ai/openai-codex/token-store.ts';

const OLD_GBRAIN_HOME = process.env.GBRAIN_HOME;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gbrain-openai-codex-token-'));
  process.env.GBRAIN_HOME = root;
});

afterEach(() => {
  if (OLD_GBRAIN_HOME === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = OLD_GBRAIN_HOME;
  if (root) rmSync(root, { recursive: true, force: true });
});

function sampleToken(overrides: Partial<OpenAICodexTokenRecord> = {}): OpenAICodexTokenRecord {
  return {
    access_token: 'access-token-secret-1234567890',
    refresh_token: 'refresh-token-secret-1234567890',
    expires_at: '2030-01-01T00:00:00.000Z',
    token_type: 'Bearer',
    scope: 'openid profile email',
    account_id: 'acct-test',
    ...overrides,
  };
}

describe('openai-codex TokenStore', () => {
  test('in-memory store supports get/set/delete without leaking references', async () => {
    const store = new InMemoryTokenStore();
    const token = sampleToken();
    await store.set(token);
    const loaded = await store.get();
    expect(loaded).toEqual(token);
    if (!loaded) throw new Error('expected token');
    loaded.access_token = 'mutated';
    expect((await store.get())?.access_token).toBe(token.access_token);
    await store.delete();
    expect(await store.get()).toBeNull();
  });

  test('file store writes fallback credentials with 0600 permissions and private parent', async () => {
    const store = new FileTokenStore();
    await store.set(sampleToken());
    const path = tokenCredentialPath();
    expect(existsSync(path)).toBe(true);
    const fileMode = (await stat(path)).mode & 0o777;
    const parentMode = (await stat(join(root, '.gbrain'))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(parentMode).toBe(0o700);
    expect(await store.get()).toEqual(sampleToken());
  });

  test('file store updates atomically through a temp file + rename path', async () => {
    const store = new FileTokenStore();
    await store.set(sampleToken({ access_token: 'first-access-token-1234567890' }));
    await store.set(sampleToken({ access_token: 'second-access-token-1234567890' }));
    const raw = readFileSync(tokenCredentialPath(), 'utf8');
    expect(raw).toContain('second-access-token-1234567890');
    expect(raw).not.toContain('first-access-token-1234567890');
    expect(await store.get()).toEqual(sampleToken({ access_token: 'second-access-token-1234567890' }));
  });

  test('file store refuses loose credential file permissions', async () => {
    const path = tokenCredentialPath();
    mkdirSync(join(root, '.gbrain'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(sampleToken()), { mode: 0o644 });
    chmodSync(path, 0o644);
    const store = new FileTokenStore();
    await expect(store.get()).rejects.toThrow(/permissions.*0600/i);
  });

  test('file store refuses symlink credential paths', async () => {
    const path = tokenCredentialPath();
    mkdirSync(join(root, '.gbrain'), { recursive: true, mode: 0o700 });
    const outside = join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify(sampleToken()), { mode: 0o600 });
    symlinkSync(outside, path);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    const store = new FileTokenStore();
    await expect(store.get()).rejects.toThrow(/symlink/i);
  });

  test('file store refuses explicit paths outside GBRAIN_HOME', () => {
    const outside = join(root, '..', 'outside-token.json');
    expect(() => new FileTokenStore(outside)).toThrow(/outside GBRAIN_HOME/i);
  });

  test('redacts token-like substrings in diagnostics', () => {
    const message = 'access_token=access-token-secret-1234567890 refresh_token refresh-token-secret-1234567890 sk-proj-abcdefghijklmnopqrstuvwxyz';
    const redacted = redactTokenLike(message);
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('access-token-secret-1234567890');
    expect(redacted).not.toContain('refresh-token-secret-1234567890');
    expect(redacted).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
  });

  test('Keychain store uses execFile-style argument arrays and updates duplicate items', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const store = new KeychainTokenStore('svc; rm -rf /', 'acct $(whoami)', {
      platform: 'darwin',
      execFile: (file, args) => {
        calls.push({ file, args });
        return '';
      },
    });
    await store.set(sampleToken());
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('security');
    expect(calls[0].args.slice(0, 2)).toEqual(['add-generic-password', '-U']);
    expect(calls[0].args).toContain('svc; rm -rf /');
    expect(calls[0].args).toContain('acct $(whoami)');
    expect(calls[0].args.join(' ')).not.toContain('sh -c');
  });

  test('Keychain delete ignores missing items but reports redacted hard failures', async () => {
    const missing = new KeychainTokenStore('svc', 'acct', {
      platform: 'darwin',
      execFile: () => {
        throw new Error('The specified item could not be found in the keychain.');
      },
    });
    await expect(missing.delete()).resolves.toBeUndefined();

    const failing = new KeychainTokenStore('svc', 'acct', {
      platform: 'darwin',
      execFile: () => {
        throw new Error('boom refresh_token=refresh-token-secret-1234567890');
      },
    });
    await expect(failing.delete()).rejects.toThrow(/\[REDACTED\]/);
    await expect(failing.delete()).rejects.not.toThrow(/refresh-token-secret/);
  });
});
