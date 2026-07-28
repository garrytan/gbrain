import { describe, expect, test } from 'bun:test';
import {
  readLineSafe,
  runProviderChooser,
  type ReadLineSafeIO,
} from '../src/commands/init.ts';
import type { Recipe } from '../src/core/ai/types.ts';

function embeddingRecipe(
  id: string,
  requiredEnv: string[],
  dims: number,
): Recipe {
  return {
    id,
    name: `${id} provider`,
    tier: id === 'openai' ? 'native' : 'openai-compat',
    implementation: id === 'openai' ? 'native-openai' : 'openai-compatible',
    auth_env: { required: requiredEnv },
    touchpoints: {
      embedding: {
        models: [`${id}-embedding-model`],
        default_dims: dims,
      },
    },
  };
}

const RECIPES: Recipe[] = [
  embeddingRecipe('openai', ['OPENAI_API_KEY'], 3072),
  embeddingRecipe('ollama', [], 768),
  embeddingRecipe('google', ['GOOGLE_GENERATIVE_AI_API_KEY'], 768),
  embeddingRecipe('voyage', ['VOYAGE_API_KEY'], 1024),
];

async function recommendedDefault(env: NodeJS.ProcessEnv): Promise<{
  defaultValue: string;
  logs: string[];
  choice: { model: string; dims: number } | null;
}> {
  let defaultValue = '';
  const logs: string[] = [];
  const choice = await runProviderChooser({
    isTTY: true,
    env,
    recipes: RECIPES,
    log: message => { logs.push(message ?? ''); },
    readLine: async (_prompt, fallback) => {
      defaultValue = fallback;
      return fallback;
    },
  });
  return { defaultValue, logs, choice };
}

describe('init embedding provider chooser', () => {
  test.each([
    [{ OPENAI_API_KEY: 'openai-secret' }, '1', 'openai:openai-embedding-model'],
    [{ OLLAMA_HOST: 'http://127.0.0.1:11434' }, '2', 'ollama:ollama-embedding-model'],
    [{ GOOGLE_GENERATIVE_AI_API_KEY: 'google-secret' }, '3', 'google:google-embedding-model'],
    [{ VOYAGE_API_KEY: 'voyage-secret' }, '4', 'voyage:voyage-embedding-model'],
  ] as const)('recommends the configured provider for env %o', async (env, expectedDefault, expectedModel) => {
    const result = await recommendedDefault(env);
    expect(result.defaultValue).toBe(expectedDefault);
    expect(result.choice?.model).toBe(expectedModel);
  });

  test('OpenAI wins the documented recommendation priority when multiple providers are configured', async () => {
    const result = await recommendedDefault({
      OPENAI_API_KEY: 'openai-secret',
      VOYAGE_API_KEY: 'voyage-secret',
    });
    expect(result.defaultValue).toBe('1');
    expect(result.choice).toEqual({ model: 'openai:openai-embedding-model', dims: 3072 });
  });

  test('Enter accepts the recommendation supplied as the reader fallback', async () => {
    const result = await recommendedDefault({ VOYAGE_API_KEY: 'voyage-secret' });
    expect(result.defaultValue).toBe('4');
    expect(result.choice).toEqual({ model: 'voyage:voyage-embedding-model', dims: 1024 });
  });

  test('a valid explicit index selects that provider', async () => {
    const choice = await runProviderChooser({
      isTTY: true,
      env: {},
      recipes: RECIPES,
      log: () => {},
      readLine: async () => '3',
    });
    expect(choice).toEqual({ model: 'google:google-embedding-model', dims: 768 });
  });

  test.each(['skip', 's', '0', '99', 'invalid'])('input %p skips without a provider choice', async input => {
    const choice = await runProviderChooser({
      isTTY: true,
      env: {},
      recipes: RECIPES,
      log: () => {},
      readLine: async () => input,
    });
    expect(choice).toBeNull();
  });

  test('non-TTY mode returns immediately without invoking the reader', async () => {
    let readerCalled = false;
    const choice = await runProviderChooser({
      isTTY: false,
      env: { OPENAI_API_KEY: 'secret' },
      recipes: RECIPES,
      readLine: async () => {
        readerCalled = true;
        return '1';
      },
    });
    expect(choice).toBeNull();
    expect(readerCalled).toBe(false);
  });

  test('provider menu reports key presence without printing secret values', async () => {
    const secret = 'sk-must-not-appear-in-output';
    const result = await recommendedDefault({ OPENAI_API_KEY: secret });
    const output = result.logs.join('\n');
    expect(output).toContain('[key found]');
    expect(output).not.toContain(secret);
  });

  test('passes the bounded timeout to the reader', async () => {
    let observedTimeout = 0;
    const choice = await runProviderChooser({
      isTTY: true,
      env: {},
      recipes: RECIPES,
      timeoutMs: 25,
      log: () => {},
      readLine: async (_prompt, fallback, timeoutMs) => {
        observedTimeout = timeoutMs;
        return fallback;
      },
    });
    expect(observedTimeout).toBe(25);
    expect(choice).toEqual({ model: 'openai:openai-embedding-model', dims: 3072 });
  });
});

function fakeReadLineIO(isTTY = true): ReadLineSafeIO & {
  output: string[];
  emitData(chunk: Buffer | string): void;
  emitEnd(): void;
  paused: boolean;
} {
  let dataListener: ((chunk: Buffer | string) => void) | null = null;
  let endListener: (() => void) | null = null;
  const output: string[] = [];

  return {
    isTTY,
    output,
    paused: false,
    write(value) { output.push(value); },
    setEncoding() {},
    onData(listener) { dataListener = listener; },
    onEnd(listener) { endListener = listener; },
    offData(listener) {
      if (dataListener === listener) dataListener = null;
    },
    offEnd(listener) {
      if (endListener === listener) endListener = null;
    },
    resume() {},
    pause() { this.paused = true; },
    emitData(chunk) { dataListener?.(chunk); },
    emitEnd() { endListener?.(); },
  };
}

describe('readLineSafe', () => {
  test('empty TTY input resolves to the supplied default', async () => {
    const io = fakeReadLineIO();
    const pending = readLineSafe('Provider [2]: ', '2', 1_000, io);
    io.emitData('\n');
    expect(await pending).toBe('2');
    expect(io.paused).toBe(true);
  });

  test('timeout resolves to the default and reports the fallback', async () => {
    const io = fakeReadLineIO();
    const result = await readLineSafe('Provider [3]: ', '3', 5, io);
    expect(result).toBe('3');
    expect(io.output.join('')).toContain('timeout after 0s, using default: 3');
    expect(io.paused).toBe(true);
  });

  test('non-TTY mode resolves immediately without writing a prompt', async () => {
    const io = fakeReadLineIO(false);
    expect(await readLineSafe('Provider [1]: ', '1', 5, io)).toBe('1');
    expect(io.output).toEqual([]);
  });
});
