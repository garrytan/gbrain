import { describe, test, expect } from 'bun:test';
import {
  CodexOAuthInferenceError,
  runCodexOAuthInference,
  sanitizeInferenceEnv,
} from '../src/core/ingest/codex-oauth.ts';

describe('Codex OAuth inference adapter', () => {
  test('calls the injected runner with explicit gpt-5.4-mini', async () => {
    const calls: unknown[] = [];
    const result = await runCodexOAuthInference({
      prompt: 'Extract cited entities.',
      model: 'gpt-5.4-mini',
      runner: async (req) => {
        calls.push(req);
        return { text: '{"entities":[]}', route: 'codex-oauth' };
      },
    });

    expect(result.text).toBe('{"entities":[]}');
    expect(calls).toEqual([
      expect.objectContaining({ prompt: 'Extract cited entities.', model: 'gpt-5.4-mini' }),
    ]);
  });

  test('rejects omitted or non-mini models before invoking a runner', async () => {
    let invoked = false;
    const runner = async () => {
      invoked = true;
      return { text: 'nope', route: 'codex-oauth' as const };
    };

    await expect(runCodexOAuthInference({ prompt: 'x', model: undefined as any, runner }))
      .rejects.toThrow(/requires model=gpt-5.4-mini/);
    await expect(runCodexOAuthInference({ prompt: 'x', model: 'gpt-5.4', runner }))
      .rejects.toThrow(/requires model=gpt-5.4-mini/);
    await expect(runCodexOAuthInference({ prompt: 'x', model: 'gpt-5.5', runner }))
      .rejects.toThrow(/requires model=gpt-5.4-mini/);
    expect(invoked).toBe(false);
  });

  test('strips OpenAI API keys from the live runner environment', () => {
    const env = sanitizeInferenceEnv({
      OPENAI_API_KEY: 'sk-secret',
      GBRAIN_EMBEDDINGS_OPENAI_API_KEY: 'sk-embed',
      GBRAIN_OPENAI_EMBEDDING_API_KEY: 'sk-embed2',
      CODEX_HOME: '/tmp/codex',
      PATH: '/bin',
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GBRAIN_EMBEDDINGS_OPENAI_API_KEY).toBeUndefined();
    expect(env.GBRAIN_OPENAI_EMBEDDING_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBe('/tmp/codex');
    expect(env.PATH).toBe('/bin');
  });

  test('missing Codex OAuth route fails closed as a configuration error', async () => {
    await expect(runCodexOAuthInference({
      prompt: 'x',
      model: 'gpt-5.4-mini',
      runner: async () => {
        throw new CodexOAuthInferenceError('codex CLI not found', 'configuration_error');
      },
    })).rejects.toMatchObject({
      code: 'configuration_error',
    });
  });

  test('times out an injected runner and reports a sanitized timeout', async () => {
    await expect(runCodexOAuthInference({
      prompt: 'secret prompt should not appear in errors',
      model: 'gpt-5.4-mini',
      timeoutMs: 5,
      runner: async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return { text: '{"late":true}', route: 'codex-oauth' };
      },
    })).rejects.toMatchObject({
      code: 'timeout',
      message: expect.not.stringContaining('secret prompt'),
    });
  });

  test('aborts an injected runner and reports an abort without raw prompt text', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('operator-cancelled')), 5);

    await expect(runCodexOAuthInference({
      prompt: 'do not leak this cancellation prompt',
      model: 'gpt-5.4-mini',
      signal: controller.signal,
      runner: async (req) => {
        expect((req as any).signal).toBe(controller.signal);
        await new Promise(resolve => setTimeout(resolve, 30));
        return { text: '{"late":true}', route: 'codex-oauth' };
      },
    })).rejects.toMatchObject({
      code: 'aborted',
      message: expect.not.stringContaining('do not leak'),
    });
  });

  test('classifies empty runner output as empty_output', async () => {
    await expect(runCodexOAuthInference({
      prompt: 'x',
      model: 'gpt-5.4-mini',
      runner: async () => ({ text: '   ', route: 'codex-oauth' }),
    })).rejects.toMatchObject({
      code: 'empty_output',
    });
  });

  test('classifies auth-like runner failures without leaking stderr or secrets', async () => {
    await expect(runCodexOAuthInference({
      prompt: 'x',
      model: 'gpt-5.4-mini',
      runner: async () => {
        const error = new Error('Command failed with stderr: login required sk-test-secret-value');
        (error as any).stderr = 'Please run codex login with token sk-test-secret-value';
        throw error;
      },
    })).rejects.toMatchObject({
      code: 'oauth_unavailable',
      message: expect.not.stringContaining('sk-test-secret-value'),
    });
  });
});
