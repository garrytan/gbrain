import { describe, expect, test } from 'bun:test';

import {
  envReady,
  formatRecipeTable,
  runProviders,
  type ProvidersCommandOptions,
} from '../../src/commands/providers.ts';
import { getRecipe, listRecipes } from '../../src/core/ai/recipes/index.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';
import { withEnv } from '../helpers/with-env.ts';

const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOME = '/fixture-home';
const OPENAI_CODEX_ACCESS_TOKEN = 'OPENAI_CODEX_ACCESS_TOKEN';
const VALID_TOKEN = jwt(Date.UTC(2030, 0, 1, 0, 0, 0) / 1000);
const EXIT_SENTINEL = '__providers_exit__';

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function jwt(expSeconds: number): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: 'acct_fixture', exp: expSeconds })}.sig`;
}

function codexOptions(): ProvidersCommandOptions {
  return {
    codexAuth: {
      homeDir: HOME,
      now: NOW_MS,
      readFileText: () => {
        throw new Error('fixture auth file intentionally missing');
      },
    },
  };
}

async function withProvidersEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  return withEnv({
    GBRAIN_HOME: '/tmp/gbrain-providers-openai-codex-test',
    GBRAIN_DATABASE_URL: undefined,
    DATABASE_URL: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_CODEX_ACCESS_TOKEN: undefined,
    OPENAI_CODEX_BASE_URL: undefined,
    OLLAMA_BASE_URL: undefined,
    LMSTUDIO_BASE_URL: undefined,
    ...overrides,
  }, async () => {
    try {
      return await fn();
    } finally {
      resetGateway();
    }
  });
}

async function captureRun(fn: () => void | Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  exitCode?: number;
}> {
  const logs: string[] = [];
  const errs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let exitCode: number | undefined;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(' '));
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(EXIT_SENTINEL);
  }) as typeof process.exit;

  try {
    await fn();
  } catch (error) {
    if (!(error instanceof Error && error.message === EXIT_SENTINEL)) throw error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

function codexLine(output: string): string {
  const line = output.split('\n').find(candidate => candidate.startsWith('openai-codex'));
  if (!line) throw new Error(`openai-codex row not found in output:\n${output}`);
  return line;
}

function parseExplainJson(stdout: string): any {
  return JSON.parse(stdout);
}

describe('openai-codex provider readiness', () => {
  test('envReady and list do not treat public OPENAI_API_KEY as Codex auth', async () => {
    const recipe = getRecipe('openai-codex');
    expect(recipe).toBeDefined();

    await withProvidersEnv({ OPENAI_API_KEY: 'sk-public-key-not-codex' }, async () => {
      expect(envReady(recipe!, process.env, codexOptions())).toBe(false);

      const table = formatRecipeTable(listRecipes(), process.env, codexOptions());
      const pureLine = codexLine(table);
      expect(pureLine).toContain('✗ Codex auth unavailable');
      expect(pureLine).not.toContain('✓ ready');
      expect(pureLine).not.toContain('sk-public-key-not-codex');

      const captured = await captureRun(() => runProviders('list', [], codexOptions()));
      expect(captured.exitCode).toBeUndefined();
      const line = codexLine(captured.stdout);
      expect(line).toContain('✗ Codex auth unavailable');
      expect(line).not.toContain('✓ ready');
      expect(captured.stdout).not.toContain('sk-public-key-not-codex');
    });
  });

  test('list marks openai-codex ready with a valid env-token fixture', async () => {
    await withProvidersEnv({ [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN }, async () => {
      const captured = await captureRun(() => runProviders('list', [], codexOptions()));
      expect(captured.exitCode).toBeUndefined();
      expect(codexLine(captured.stdout)).toContain('✓ ready');
    });
  });

  test('env reports Codex auth status, public OpenAI non-use, and base URL override', async () => {
    await withProvidersEnv({
      [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN,
      OPENAI_CODEX_BASE_URL: 'http://codex-proxy.example.test/v1',
    }, async () => {
      const captured = await captureRun(() => runProviders('env', ['openai-codex'], codexOptions()));
      expect(captured.exitCode).toBeUndefined();
      expect(captured.stdout).toContain('OPENAI_CODEX_ACCESS_TOKEN');
      expect(captured.stdout).toContain('Codex auth: Codex auth ready');
      expect(captured.stdout).toContain('Public OpenAI API key: not used for openai-codex');
      expect(captured.stdout).toContain('Base URL: http://codex-proxy.example.test/v1');
      expect(captured.stdout).not.toContain(VALID_TOKEN);
    });
  });

  test('explain JSON reflects missing vs valid Codex auth and base URL override', async () => {
    await withProvidersEnv({ OPENAI_API_KEY: 'sk-public-key-not-codex' }, async () => {
      const captured = await captureRun(() => runProviders('explain', ['--json'], codexOptions()));
      expect(captured.exitCode).toBeUndefined();
      const matrix = parseExplainJson(captured.stdout);
      const option = matrix.options.find((candidate: any) => candidate.id === 'openai-codex:gpt-5.5');
      expect(option).toBeDefined();
      expect(option.env_ready).toBe(false);
      expect(matrix.env_detected.OPENAI_API_KEY).toBe(true);
      expect(JSON.stringify(matrix)).not.toContain('sk-public-key-not-codex');
    });

    await withProvidersEnv({
      [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN,
      OPENAI_CODEX_BASE_URL: 'http://codex-proxy.example.test/v1',
    }, async () => {
      const captured = await captureRun(() => runProviders('explain', ['--json'], codexOptions()));
      expect(captured.exitCode).toBeUndefined();
      const matrix = parseExplainJson(captured.stdout);
      const option = matrix.options.find((candidate: any) => candidate.id === 'openai-codex:gpt-5.5');
      expect(option).toBeDefined();
      expect(option.touchpoint).toBe('chat');
      expect(option.env_ready).toBe(true);
      expect(option.base_url).toBe('http://codex-proxy.example.test/v1');
      expect(JSON.stringify(matrix)).not.toContain(VALID_TOKEN);
    });
  });

  test('providers test fails readiness when Codex auth is missing', async () => {
    await withProvidersEnv({ OPENAI_API_KEY: 'sk-public-key-not-codex' }, async () => {
      const captured = await captureRun(() => runProviders(
        'test',
        ['--touchpoint', 'chat', '--model', 'openai-codex:gpt-5.5'],
        codexOptions(),
      ));

      expect(captured.exitCode).toBe(1);
      expect(captured.stderr).toContain('Chat provider unavailable: Codex auth unavailable');
      expect(captured.stderr).not.toContain('sk-public-key-not-codex');
    });
  });

  test('providers test passes auth readiness and probes Codex streaming transport with valid env-token', async () => {
    await withProvidersEnv({ [OPENAI_CODEX_ACCESS_TOKEN]: VALID_TOKEN }, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response([
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","delta":"pong"}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;

      try {
        const captured = await captureRun(() => runProviders(
          'test',
          ['--touchpoint', 'chat', '--model', 'openai-codex:gpt-5.5'],
          codexOptions(),
        ));

        expect(captured.exitCode ?? 0).toBe(0);
        expect(captured.stdout).toContain('Probing chat provider...');
        expect(captured.stdout).toContain('All probes green.');
        expect(captured.stdout).toContain('model=openai-codex:gpt-5.5');
        expect(captured.stdout).toContain('"pong"');
        expect(captured.stderr).not.toContain(VALID_TOKEN);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
