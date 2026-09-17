/**
 * `chatWithFallback`: `chat()` consults the configured
 * `chat_fallback_chain` when the primary model errors or completes with a
 * D8 structural signal (stopReason 'refusal' / 'content_filter').
 *
 * Hermetic via `__setChatTransportForTests` — provider resolution never runs
 * (the transport seam sits before it), so the fallback chain models don't
 * need real recipes or keys in these tests; what is exercised is the
 * orchestration: attempt order, error eligibility, structural-signal
 * fallthrough, dedup, and the allowFallback escape hatch.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  chat,
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';

type Transport = (opts: { model?: string; messages: unknown[] }) => Promise<ChatResult>;

afterEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
});

function ok(max: string): Transport {
  return async (opts) => ({
    text: `ok via ${opts.model ?? max}`,
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: opts.model ?? max,
    providerId: 'openai',
  });
}

function fail(err: Error): Transport {
  return async () => {
    throw err;
  };
}

const CHAIN_CFG = {
  env: { OPENAI_API_KEY: 'sk-fake', AMD_API_KEY: 'rc-fake' },
  chat_fallback_chain: ['amd:DeepSeek-V4-Flash', 'amd:Qwen3.8-Flash-Next'],
};

describe('chat() fallback chain (chatWithFallback)', () => {
  test('primary succeeds → chain never consulted (one attempt)', async () => {
    configureGateway(CHAIN_CFG);
    let calls = 0;
    __setChatTransportForTests(async (opts) => {
      calls += 1;
      return ok('openai:gpt-4o')(opts);
    });
    const res = await chat({ model: 'openai:gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls).toBe(1);
    expect(res.model).toBe('openai:gpt-4o');
  });

  test('primary throws → next chain entry handles (attempt order honored)', async () => {
    configureGateway(CHAIN_CFG);
    const seen: (string | undefined)[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model);
      if (seen.length === 1) throw new Error('429 rate_limit');
      return ok('amd:DeepSeek-V4-Flash')(opts);
    });
    const res = await chat({ model: 'openai:gpt-4o', messages: [] });
    expect(seen).toEqual(['openai:gpt-4o', 'amd:DeepSeek-V4-Flash']);
    expect(res.model).toBe('amd:DeepSeek-V4-Flash');
    expect(res.text).toBe('ok via amd:DeepSeek-V4-Flash');
  });

  test('refusal (structural signal, D8) falls through even though the call succeeded', async () => {
    configureGateway(CHAIN_CFG);
    const seen: (string | undefined)[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model);
      if (seen.length === 1) {
        const base = await ok('openai:gpt-4o')(opts);
        return { ...base, stopReason: 'refusal', text: '' };
      }
      return ok('amd:DeepSeek-V4-Flash')(opts);
    });
    const res = await chat({ model: 'openai:gpt-4o', messages: [] });
    expect(seen).toEqual(['openai:gpt-4o', 'amd:DeepSeek-V4-Flash']);
    expect(res.stopReason).toBe('end');
  });

  test('content_filter also falls through', async () => {
    configureGateway(CHAIN_CFG);
    let calls = 0;
    __setChatTransportForTests(async (opts) => {
      calls += 1;
      if (calls === 1) {
        const base = await ok('openai:gpt-4o')(opts);
        return { ...base, stopReason: 'content_filter' };
      }
      return ok('amd:DeepSeek-V4-Flash')(opts);
    });
    const res = await chat({ model: 'openai:gpt-4o', messages: [] });
    expect(calls).toBe(2);
    expect(res.model).toBe('amd:DeepSeek-V4-Flash');
  });

  test('whole chain fails → the LAST error surfaces (normalized)', async () => {
    configureGateway(CHAIN_CFG);
    const seen: (string | undefined)[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model);
      throw new Error('provider down');
    });
    await expect(chat({ model: 'openai:gpt-4o', messages: [] })).rejects.toThrow();
    expect(seen.length).toBe(3); // primary + 2 chain entries
  });

  test('chain entry equal to the primary is deduplicated (does not re-run primary)', async () => {
    configureGateway({ ...CHAIN_CFG, chat_fallback_chain: ['openai:gpt-4o', 'amd:DeepSeek-V4-Flash'] });
    const seen: (string | undefined)[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model);
      throw new Error('down');
    });
    await expect(chat({ model: 'openai:gpt-4o', messages: [] })).rejects.toThrow();
    // primary (oai) + amd; the duplicate 'openai:gpt-4o' chain entry was dropped.
    expect(seen).toEqual(['openai:gpt-4o', 'amd:DeepSeek-V4-Flash']);
  });

  test('allowFallback:false bypasses the chain entirely even when configured', async () => {
    configureGateway(CHAIN_CFG);
    let calls = 0;
    __setChatTransportForTests(async (opts) => {
      calls += 1;
      throw new Error('down');
    });
    await expect(
      chat({ model: 'openai:gpt-4o', messages: [], allowFallback: false }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test('no chain configured → single attempt, original error (not normalized away)', async () => {
    configureGateway({ env: { OPENAI_API_KEY: 'sk-fake' } });
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls += 1;
      throw new Error('original provider error');
    });
    await expect(chat({ model: 'openai:gpt-4o', messages: [] })).rejects.toThrow(
      'original provider error',
    );
    expect(calls).toBe(1);
  });
});