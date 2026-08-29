/**
 * gbrain sources add --kind google — the v0.47 non-vault access flags
 * (--access vault|command|env, --token-command, --token-env) on a real PGLite
 * engine (src/commands/sources.ts:runAdd → src/core/sources-ops.ts Path D).
 *
 * Output capture swaps process.stdout/stderr.write AND console.log/error
 * (Bun's console does not route through the stream swap) and stubs
 * process.exit — the same harness family as test/loops-cli.test.ts. Every
 * test runs under a temp GBRAIN_HOME so the credential vault and the managed
 * clone dir are hermetic. Synthetic accounts only (alice@example.com).
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runSources } from '../src/commands/sources.ts';
import type { VaultFileShape } from '../src/core/creds/vault.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

interface Captured {
  out: string;
  err: string;
  /** Set only when the command hard-called process.exit(code). */
  exitCalled: number | undefined;
}

async function captured(fn: () => Promise<void>): Promise<Captured> {
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  const logOrig = console.log;
  const cerrOrig = console.error;
  const exitOrig = process.exit;
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  let exitCalled: number | undefined;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  console.log = (...a: unknown[]) => {
    outChunks.push(a.map(String).join(' ') + '\n');
  };
  console.error = (...a: unknown[]) => {
    errChunks.push(a.map(String).join(' ') + '\n');
  };
  process.exit = ((code?: number) => {
    exitCalled = code ?? 0;
    throw new Error('__exit__');
  }) as typeof process.exit;
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = exitOrig;
    console.log = logOrig;
    console.error = cerrOrig;
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
  }
  return { out: outChunks.join(''), err: errChunks.join(''), exitCalled };
}

/** Run `gbrain sources add <id> --kind google --account alice@example.com …`
 *  under a fresh temp GBRAIN_HOME (returned for vault seeding via `seed`). */
async function addGoogle(
  id: string,
  extra: string[],
  opts: { seed?: (home: string) => void; env?: Record<string, string | undefined> } = {},
): Promise<Captured> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-gflags-home-'));
  opts.seed?.(home);
  return withEnv({ GBRAIN_HOME: home, ...(opts.env ?? {}) }, () =>
    captured(() =>
      runSources(engine, ['add', id, '--kind', 'google', '--account', 'alice@example.com', ...extra]),
    ),
  );
}

async function sourceConfig(id: string): Promise<Record<string, unknown> | null> {
  const rows = await engine.executeRaw<{ config: unknown }>(
    `SELECT config FROM sources WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const c = rows[0].config;
  return typeof c === 'string' ? (JSON.parse(c) as Record<string, unknown>) : ((c ?? {}) as Record<string, unknown>);
}

/** Write a minimal vault with a connected google:alice@example.com entry. */
function seedVault(home: string): void {
  const dir = join(home, '.gbrain');
  mkdirSync(dir, { recursive: true });
  const shape: VaultFileShape = {
    version: 1,
    clients: [],
    credentials: {
      'google:alice@example.com': {
        id: 'google:alice@example.com',
        provider: 'google',
        kind: 'oauth2',
        client_ref: 'byo',
        secret: {
          access_token: 't',
          refresh_token: 'r',
          expiry: new Date(Date.now() + 3_600_000).toISOString(),
        },
        meta: { account: 'alice@example.com', connected_at: new Date().toISOString() },
      },
    },
  };
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify(shape, null, 2), { mode: 0o600 });
}

describe('sources add --kind google access-flag validation (exit 2)', () => {
  test('unknown --access value → exit 2, nothing registered', async () => {
    const r = await addGoogle('gbad', ['--access', 'bogus']);
    expect(r.exitCalled).toBe(2);
    expect(r.err).toContain('unknown --access "bogus"');
    expect(await sourceConfig('gbad')).toBeNull();
  });

  test('--access command without --token-command → exit 2', async () => {
    const r = await addGoogle('gcmd-missing', ['--access', 'command']);
    expect(r.exitCalled).toBe(2);
    expect(r.err).toContain('--access command requires --token-command');
    expect(await sourceConfig('gcmd-missing')).toBeNull();
  });

  test('--access env without --token-env → exit 2', async () => {
    const r = await addGoogle('genv-missing', ['--access', 'env']);
    expect(r.exitCalled).toBe(2);
    expect(r.err).toContain('--access env requires --token-env');
    expect(await sourceConfig('genv-missing')).toBeNull();
  });

  test('token flags without a non-vault --access → exit 2 (bare and explicit --access vault)', async () => {
    const bare = await addGoogle('gtok-bare', ['--token-command', 'echo tok-abcdef123']);
    expect(bare.exitCalled).toBe(2);
    expect(bare.err).toContain('--token-command/--token-env require --access command or --access env');
    expect(await sourceConfig('gtok-bare')).toBeNull();

    const explicit = await addGoogle('gtok-vault', ['--access', 'vault', '--token-env', 'G_FAKE_TOKEN']);
    expect(explicit.exitCalled).toBe(2);
    expect(explicit.err).toContain('--token-command/--token-env require --access command or --access env');
    expect(await sourceConfig('gtok-vault')).toBeNull();
  });
});

describe('sources add --kind google command mode', () => {
  test('registers without any vault entry; config carries g_access + g_token_command', async () => {
    const r = await addGoogle('gcmd', ['--access', 'command', '--token-command', 'echo tok-abcdef123']);
    expect(r.exitCalled).toBeUndefined();
    expect(r.out).toContain('Created source "gcmd"');
    expect(r.err).not.toContain('probe failed'); // the echo probe succeeded
    const cfg = (await sourceConfig('gcmd'))!;
    expect(cfg.kind).toBe('google');
    expect(cfg.g_account).toBe('alice@example.com');
    expect(cfg.g_access).toBe('command');
    expect(cfg.g_token_command).toBe('echo tok-abcdef123');
    expect('g_token_env' in cfg).toBe(false);
  });

  test('a failing probe command warns but still registers (best-effort probe)', async () => {
    const r = await addGoogle('gcmd-probe', ['--access', 'command', '--token-command', 'exit 5']);
    expect(r.exitCalled).toBeUndefined();
    expect(r.err).toContain('token command probe failed');
    expect(r.out).toContain('Created source "gcmd-probe"');
    const cfg = (await sourceConfig('gcmd-probe'))!;
    expect(cfg.g_access).toBe('command');
    expect(cfg.g_token_command).toBe('exit 5');
  });
});

describe('sources add --kind google env mode', () => {
  test('registers with g_access + g_token_env; a set var raises no warning', async () => {
    const r = await addGoogle('genv', ['--access', 'env', '--token-env', 'GBRAIN_TEST_GFLAGS_TOKEN'], {
      env: { GBRAIN_TEST_GFLAGS_TOKEN: 'env-token-abc123' },
    });
    expect(r.exitCalled).toBeUndefined();
    expect(r.out).toContain('Created source "genv"');
    expect(r.err).not.toContain('is not set in this shell');
    const cfg = (await sourceConfig('genv'))!;
    expect(cfg.g_access).toBe('env');
    expect(cfg.g_token_env).toBe('GBRAIN_TEST_GFLAGS_TOKEN');
    expect('g_token_command' in cfg).toBe(false);
  });

  test('an unset var warns but still registers', async () => {
    const r = await addGoogle('genv-warn', ['--access', 'env', '--token-env', 'GBRAIN_TEST_GFLAGS_TOKEN'], {
      env: { GBRAIN_TEST_GFLAGS_TOKEN: undefined },
    });
    expect(r.exitCalled).toBeUndefined();
    expect(r.err).toContain('$GBRAIN_TEST_GFLAGS_TOKEN is not set in this shell');
    expect(r.out).toContain('Created source "genv-warn"');
    expect((await sourceConfig('genv-warn'))!.g_access).toBe('env');
  });
});

describe('--token-env is shared by both kinds (github shadowing regression)', () => {
  test('--kind github --token-env <VAR> lands in gh_token_env (parsed once, routed by kind)', async () => {
    // The flag is legitimately shared: github reads its API token from the
    // named var; google's env access mode reads an access token from it.
    // Parsed once and routed by kind — an earlier draft's separate google
    // parse shadowed the github one and silently dropped the flag.
    const home = mkdtempSync(join(tmpdir(), 'gbrain-gflags-home-'));
    const r = await withEnv({ GBRAIN_HOME: home }, () =>
      captured(() =>
        runSources(engine, ['add', 'ghtok', '--kind', 'github', '--token-env', 'GBRAIN_TEST_GH_PAT']),
      ),
    );
    expect(r.exitCalled).toBeUndefined();
    expect(r.out).toContain('Created source "ghtok"');
    const cfg = (await sourceConfig('ghtok'))!;
    expect(cfg.kind).toBe('github');
    expect(cfg.gh_token_env).toBe('GBRAIN_TEST_GH_PAT');
    // And the google-side validation does NOT fire for github adds.
    expect(r.err).not.toContain('--access');
  });
});

describe('sources add --kind google vault mode (default)', () => {
  test('with a connected vault entry: registers and writes NO g_access / g_token_* keys', async () => {
    const r = await addGoogle('gvault', [], { seed: seedVault });
    expect(r.exitCalled).toBeUndefined();
    expect(r.out).toContain('Created source "gvault"');
    const cfg = (await sourceConfig('gvault'))!;
    expect(cfg.kind).toBe('google');
    expect(cfg.g_account).toBe('alice@example.com');
    expect('g_access' in cfg).toBe(false);
    expect('g_token_command' in cfg).toBe(false);
    expect('g_token_env' in cfg).toBe(false);
  });

  test('vault preflight still fails fast when no vault entry exists (default AND explicit --access vault)', async () => {
    const bare = await addGoogle('gvault-missing', []);
    expect(bare.exitCalled).toBe(2);
    expect(bare.err).toContain('no connected Google account "alice@example.com"');
    expect(bare.err).toContain('--access command'); // the alternative modes ride the fix
    expect(await sourceConfig('gvault-missing')).toBeNull();

    const explicit = await addGoogle('gvault-missing2', ['--access', 'vault']);
    expect(explicit.exitCalled).toBe(2);
    expect(explicit.err).toContain('no connected Google account');
    expect(await sourceConfig('gvault-missing2')).toBeNull();
  });
});
