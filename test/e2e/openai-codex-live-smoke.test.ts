import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexAuthAvailable,
  resolveCodexAuthSnapshot,
  type CodexCredentialSnapshot,
} from '../../src/core/ai/codex-auth.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src/cli.ts');
const OFFLINE_PUBLIC_KEY = 'sk-offline-openai-key-must-not-leak';
const GATED_CODEX_TOKEN = 'codex-live-gate-token-must-not-leak';

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function pruneEnv(input: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function runCli(
  args: string[],
  opts: {
    gbrainHome: string;
    env?: Record<string, string | undefined>;
    inheritEnv?: boolean;
    timeoutMs?: number;
  },
): Promise<CliResult> {
  const { spawn } = await import('node:child_process');
  const baseEnv = opts.inheritEnv
    ? { ...process.env }
    : {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GBRAIN_DATABASE_URL: undefined,
        DATABASE_URL: undefined,
        OPENAI_API_KEY: undefined,
        OPENAI_CODEX_ACCESS_TOKEN: undefined,
        OPENAI_CODEX_BASE_URL: undefined,
        GBRAIN_OPENAI_CODEX_LIVE: undefined,
      };
  const env = pruneEnv({
    ...baseEnv,
    GBRAIN_HOME: opts.gbrainHome,
    ...opts.env,
  });

  return new Promise((resolve) => {
    const child = spawn('bun', ['run', CLI, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 60_000);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
}

function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-openai-codex-smoke-'));
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => rmSync(home, { recursive: true, force: true }));
}

function expectNoSecrets(output: string, secrets: Array<string | undefined>): void {
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    expect(output).not.toContain(secret);
  }
}

function liveAuthSnapshot(): CodexCredentialSnapshot | undefined {
  if (process.env.GBRAIN_OPENAI_CODEX_LIVE !== '1') return undefined;
  return resolveCodexAuthSnapshot({ env: process.env });
}

const LIVE_SNAPSHOT = liveAuthSnapshot();
const LIVE_READY = process.env.GBRAIN_OPENAI_CODEX_LIVE === '1' && codexAuthAvailable(LIVE_SNAPSHOT);

describe('openai-codex readiness smoke', () => {
  test('providers verify --offline passes without live auth/network or secret leakage', async () => {
    await withTempHome(async (home) => {
      const result = await runCli(
        ['providers', 'verify', '--model', 'openai-codex:gpt-5.5', '--offline'],
        {
          gbrainHome: home,
          env: { OPENAI_API_KEY: OFFLINE_PUBLIC_KEY },
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('OpenAI Codex provider readiness (offline)');
      expect(result.stdout).toContain('recipe/model identity');
      expect(result.stdout).toContain('auth redaction');
      expect(result.stdout).toContain('streaming route separation');
      expect(result.stdout).toContain('text-only/no-tools guard');
      expect(result.stdout).toContain('no public OpenAI fallback');
      expect(result.stdout).toContain('plan billing metadata');
      expect(result.stdout).toContain('Result: READY (offline invariants passed).');
      expect(result.stderr).toBe('');
      expectNoSecrets(result.stdout + result.stderr, [OFFLINE_PUBLIC_KEY]);
    });
  });

  test('providers verify --offline fails closed for public OpenAI base URL override', async () => {
    await withTempHome(async (home) => {
      const result = await runCli(
        ['providers', 'verify', '--model', 'openai-codex:gpt-5.5', '--offline'],
        {
          gbrainHome: home,
          env: {
            OPENAI_API_KEY: OFFLINE_PUBLIC_KEY,
            OPENAI_CODEX_BASE_URL: 'https://api.openai.com/v1',
          },
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('OpenAI Codex provider readiness (offline)');
      expect(result.stdout).toContain('✗ streaming route separation');
      expect(result.stdout).toContain('✗ no public OpenAI fallback');
      expect(result.stdout).toContain('Result: NOT READY');
      expect(result.stderr).toBe('');
      expectNoSecrets(result.stdout + result.stderr, [OFFLINE_PUBLIC_KEY]);
    });
  });

  test('providers verify --offline accepts non-public Codex proxy base URL override', async () => {
    await withTempHome(async (home) => {
      const result = await runCli(
        ['providers', 'verify', '--model', 'openai-codex:gpt-5.5', '--offline'],
        {
          gbrainHome: home,
          env: {
            OPENAI_API_KEY: OFFLINE_PUBLIC_KEY,
            OPENAI_CODEX_BASE_URL: 'http://codex-proxy.example.test/v1',
          },
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('✓ streaming route separation');
      expect(result.stdout).toContain('non-public Codex Responses /responses route');
      expect(result.stdout).toContain('Result: READY (offline invariants passed).');
      expect(result.stderr).toBe('');
      expectNoSecrets(result.stdout + result.stderr, [OFFLINE_PUBLIC_KEY]);
    });
  });

  test('providers verify --live is refused unless GBRAIN_OPENAI_CODEX_LIVE=1', async () => {
    await withTempHome(async (home) => {
      const result = await runCli(
        ['providers', 'verify', '--model', 'openai-codex:gpt-5.5', '--live'],
        {
          gbrainHome: home,
          env: {
            GBRAIN_OPENAI_CODEX_LIVE: undefined,
            OPENAI_CODEX_ACCESS_TOKEN: GATED_CODEX_TOKEN,
          },
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Live Codex verify is disabled');
      expectNoSecrets(result.stdout + result.stderr, [GATED_CODEX_TOKEN]);
    });
  });

  const liveTest = LIVE_READY ? test : test.skip;
  liveTest('optional live Codex chat smoke via providers test', async () => {
    await withTempHome(async (home) => {
      const result = await runCli(
        ['providers', 'test', '--touchpoint', 'chat', '--model', 'openai-codex:gpt-5.5'],
        {
          gbrainHome: home,
          inheritEnv: true,
          env: { GBRAIN_OPENAI_CODEX_LIVE: '1' },
          timeoutMs: 120_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Probing chat provider...');
      expect(result.stdout).toContain('All probes green.');
      expect(result.stdout).toContain('model=openai-codex:gpt-5.5');
      expectNoSecrets(result.stdout + result.stderr, [
        process.env.OPENAI_API_KEY,
        process.env.OPENAI_CODEX_ACCESS_TOKEN,
        LIVE_SNAPSHOT?.ok ? LIVE_SNAPSHOT.accessToken : undefined,
        LIVE_SNAPSHOT?.ok ? LIVE_SNAPSHOT.accountId : undefined,
      ]);
    });
  }, 180_000);
});
