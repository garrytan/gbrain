// Per-tool timeout + retry inside the tool loop (takeover of #2086).
//
// Pre-fix, `toolLoop` ran `handler.execute()` unbounded: a wedged pooler or
// half-open client socket squatted the worker slot until the JOB-level
// wall-clock timeout reaped the whole job. These pin:
//   - a hung tool settles as ToolCallTimeoutError even when it ignores abort
//   - idempotent transient failures retry (bounded) and feed the successful
//     result back into the loop
//   - non-idempotent tools never retry

import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setChatTransportForTests,
  executeToolWithTimeoutAndRetry,
  toolLoop,
  type ChatResult,
} from '../src/core/ai/gateway.ts';

afterEach(() => {
  __setChatTransportForTests(null);
});

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

describe('subagent tool execution timeout/retry', () => {
  test('executeToolWithTimeoutAndRetry bounds a hung tool even if it ignores the abort signal', async () => {
    const started = Date.now();
    await expect(executeToolWithTimeoutAndRetry({
      toolName: 'brain_search',
      timeoutMs: 20,
      maxAttempts: 1,
      idempotent: true,
      execute: async () => new Promise(() => {}),
    })).rejects.toThrow('tool "brain_search" timed out after 20ms');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('caller abort (baseSignal) wins over the timeout and is NOT retried', async () => {
    const ctl = new AbortController();
    const pending = executeToolWithTimeoutAndRetry({
      toolName: 'brain_search',
      baseSignal: ctl.signal,
      timeoutMs: 60_000,
      maxAttempts: 3,
      idempotent: true,
      execute: async () => new Promise(() => {}),
    });
    ctl.abort(new Error('job cancelled'));
    await expect(pending).rejects.toThrow('job cancelled');
  });

  test('idempotent transient tool failures retry and feed the successful result back into the loop', async () => {
    let chatCalls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls += 1;
      if (chatCalls === 1) {
        return {
          text: '',
          blocks: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'brain_search', input: { query: 'supabase' } }],
          stopReason: 'tool_calls',
          usage,
          model: 'test:model',
          providerId: 'test',
        };
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }],
        stopReason: 'end',
        usage,
        model: 'test:model',
        providerId: 'test',
      };
    });

    let attempts = 0;
    const retries: number[] = [];
    const result = await toolLoop({
      model: 'test:model',
      initialMessages: [{ role: 'user', content: 'search' }],
      tools: [{ name: 'brain_search', description: 'Search', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['brain_search', {
        idempotent: true,
        async execute() {
          attempts += 1;
          if (attempts === 1) throw new Error('Cannot connect to database: CONNECT_TIMEOUT');
          return { ok: true };
        },
      }]]),
      toolTimeoutMs: 1000,
      toolMaxAttempts: 2,
      onHeartbeat(event, data) {
        if (event === 'tool_retry') retries.push(data.attempt as number);
      },
    });

    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('done');
    expect(attempts).toBe(2);
    expect(retries).toEqual([2]);
    expect(chatCalls).toBe(2);
  });

  test('non-idempotent transient tool failures do not retry', async () => {
    let attempts = 0;
    await expect(executeToolWithTimeoutAndRetry({
      toolName: 'write_side_effect',
      timeoutMs: 1000,
      maxAttempts: 3,
      idempotent: false,
      execute: async () => {
        attempts += 1;
        throw new Error('Cannot connect to database: CONNECT_TIMEOUT');
      },
    })).rejects.toThrow('Cannot connect');
    expect(attempts).toBe(1);
  });

  test('non-retryable errors surface immediately even for idempotent tools', async () => {
    let attempts = 0;
    await expect(executeToolWithTimeoutAndRetry({
      toolName: 'brain_search',
      timeoutMs: 1000,
      maxAttempts: 3,
      idempotent: true,
      execute: async () => {
        attempts += 1;
        throw new Error('page not found');
      },
    })).rejects.toThrow('page not found');
    expect(attempts).toBe(1);
  });
});
