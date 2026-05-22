import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  toolLoop,
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatBlock,
  type ToolHandler,
} from '../../src/core/ai/gateway.ts';

describe('gateway.toolLoop (v0.38 D11 — provider-agnostic loop control)', () => {
  beforeEach(() => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' },
    });
  });
  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

  it('exits cleanly on end stop_reason with no tools', async () => {
    __setChatTransportForTests(async () => ({
      text: 'hello world',
      blocks: [{ type: 'text', text: 'hello world' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    });

    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('hello world');
    expect(result.totalTurns).toBe(0); // First turn ended cleanly without tool dispatch
    expect(result.totalUsage.input_tokens).toBe(5);
  });

  it('dispatches a single tool call and feeds the result back to the next turn', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'final answer',
        blocks: [{ type: 'text', text: 'final answer' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 15, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    let toolWasCalled = false;
    const handler: ToolHandler = {
      idempotent: true,
      async execute(input) {
        toolWasCalled = true;
        expect(input).toEqual({ q: 'foo' });
        return { ok: true, results: [{ slug: 'foo/bar' }] };
      },
    };

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'find foo' }],
      tools: [{ name: 'search', description: 'search the brain', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['search', handler]]),
    });

    expect(toolWasCalled).toBe(true);
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('final answer');
    expect(result.totalUsage.input_tokens).toBe(25); // 10 + 15
    expect(result.totalUsage.output_tokens).toBe(9); // 4 + 5
  });

  it('captures persistence callbacks in order: assistant → tool start → tool complete', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'echo', input: { msg: 'hi' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 5, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    const events: string[] = [];

    await toolLoop({
      initialMessages: [{ role: 'user', content: 'echo hi' }],
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['echo', {
        idempotent: true,
        async execute(input) { events.push(`execute(${JSON.stringify(input)})`); return input; },
      }]]),
      onAssistantTurn: async (turnIdx, _msgIdx, _blocks, _usage, _model) => {
        events.push(`onAssistantTurn(${turnIdx})`);
      },
      onToolCallStart: async (turnIdx, _msgIdx, ordinal, toolName, _input, providerToolCallId) => {
        events.push(`onToolCallStart(turn=${turnIdx}, ordinal=${ordinal}, name=${toolName}, providerCallId=${providerToolCallId})`);
        return { gbrainToolUseId: `gb-${turnIdx}-${ordinal}` };
      },
      onToolCallComplete: async (gbrainToolUseId, _output) => {
        events.push(`onToolCallComplete(${gbrainToolUseId})`);
      },
    });

    // Write-ordering invariant: assistant persisted BEFORE pending tool row;
    // pending row persisted BEFORE execute; execute BEFORE complete.
    expect(events[0]).toBe('onAssistantTurn(0)');
    expect(events[1]).toMatch(/onToolCallStart\(turn=0, ordinal=0, name=echo/);
    expect(events[2]).toMatch(/execute/);
    expect(events[3]).toMatch(/onToolCallComplete\(gb-0-0\)/);
    expect(events[4]).toBe('onAssistantTurn(1)'); // final assistant turn
  });

  it('replay short-circuits a complete prior tool execution', async () => {
    let chatCalls = 0;
    __setChatTransportForTests(async () => {
      chatCalls++;
      // Turn 1 emits a tool call. Turn 2 finishes.
      if (chatCalls === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'provider-id-1', toolName: 'work', input: { x: 1 } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'fin',
        blocks: [{ type: 'text', text: 'fin' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    let executed = false;
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'work', description: 'w', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['work', {
        idempotent: false,
        async execute() { executed = true; return 'fresh'; },
      }]]),
      onToolCallStart: async () => ({ gbrainToolUseId: 'gb-replay-key' }),
      replayState: {
        priorMessages: [],
        priorTools: new Map([['gb-replay-key', {
          status: 'complete' as const,
          output: 'from-prior-run',
        }]]),
        nextTurnIdx: 0,
        nextMessageIdx: 0,
      },
    });

    expect(executed).toBe(false); // replay short-circuit
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('fin');
  });

  it('refuses replay of non-idempotent pending tool with unrecoverable error', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: 'tc-non-idem', toolName: 'mutate', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    await expect(
      toolLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'mutate', description: 'm', inputSchema: { type: 'object' } }],
        toolHandlers: new Map([['mutate', { idempotent: false, async execute() { return null; } }]]),
        onToolCallStart: async () => ({ gbrainToolUseId: 'gb-pending-key' }),
        replayState: {
          priorMessages: [],
          priorTools: new Map([['gb-pending-key', { status: 'pending' as const }]]),
          nextTurnIdx: 0,
          nextMessageIdx: 0,
        },
      }),
    ).rejects.toThrow(/non-idempotent.*pending/i);
  });

  it('hits max_turns when the model keeps calling tools', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: `tc-${Math.random()}`, toolName: 'loop', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'loop' }],
      tools: [{ name: 'loop', description: 'l', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['loop', { idempotent: true, async execute() { return null; } }]]),
      maxTurns: 3,
    });

    expect(result.stopReason).toBe('max_turns');
    expect(result.totalTurns).toBeGreaterThanOrEqual(3);
  });

  it('returns refusal reason without dispatching tools when stopReason=refusal', async () => {
    __setChatTransportForTests(async () => ({
      text: 'I cannot help with that',
      blocks: [{ type: 'text', text: 'I cannot help with that' }] as ChatBlock[],
      stopReason: 'refusal',
      usage: { input_tokens: 1, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    let toolWasCalled = false;
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'bad request' }],
      tools: [{ name: 'work', description: 'w', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['work', { idempotent: true, async execute() { toolWasCalled = true; return null; } }]]),
    });

    expect(toolWasCalled).toBe(false);
    expect(result.stopReason).toBe('refusal');
    expect(result.finalText).toBe('I cannot help with that');
  });
});
