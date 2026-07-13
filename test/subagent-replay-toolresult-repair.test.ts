import { describe, expect, it } from 'bun:test';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { reconstructReplayMessages } from '../src/core/minions/handlers/subagent.ts';
import { toModelMessages, type ChatMessage } from '../src/core/ai/gateway.ts';

// Regression guard for the gateway-loop subagent replay dropping tool-results.
//
// The gateway tool-loop persists tool executions to `subagent_tool_executions`,
// NOT as `subagent_messages` rows. Reconstructing the conversation on replay with
// a naive 1:1 map therefore yields assistant tool-call turns with no following
// tool-result message. On replay the loop seeds `messages` from the
// reconstruction and the next `generateText()` throws AI SDK v6's
// `AI_MissingToolResultsError` — fatal for any provider routed through the
// gateway loop that emits PARALLEL tool calls (a single crashed turn drops
// several tool-results at once).
//
// The pre-existing crash-replay e2e (test/e2e/subagent-crash-replay-multi-
// provider.test.ts) stubs the chat transport, so it short-circuits BEFORE
// generateText and never exercised the ModelMessage conversion — which is why
// this slipped through. The last test below drives the REAL AI SDK v6
// generateText (no network) so the failure point is actually validated.

// Anthropic/v2 content-block shapes as persisted in subagent_messages.content_blocks.
function assistantTurn(calls: { id: string; name: string; input: unknown }[]) {
  return calls.map((c) => ({ type: 'tool-call', toolCallId: c.id, toolName: c.name, input: c.input }));
}

const TWO_PARALLEL_CALLS = [
  { message_idx: 0, role: 'user' as const, content_blocks: [{ type: 'text', text: 'do the thing' }] },
  {
    message_idx: 1,
    role: 'assistant' as const,
    content_blocks: assistantTurn([
      { id: 'call_a', name: 'search', input: { q: 'x' } },
      { id: 'call_b', name: 'fetch', input: { u: 'y' } },
    ]),
  },
];

const TWO_COMPLETE_EXECS = [
  { message_idx: 1, tool_use_id: 'call_a', tool_name: 'search', status: 'complete' as const, output: { hits: 3 }, error: null },
  { message_idx: 1, tool_use_id: 'call_b', tool_name: 'fetch', status: 'complete' as const, output: { body: 'ok' }, error: null },
];

function mockModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  } as any);
}

describe('reconstructReplayMessages (gateway-loop subagent replay)', () => {
  it('re-pairs every parallel tool-call with its persisted tool-result', () => {
    const out = reconstructReplayMessages(TWO_PARALLEL_CALLS as any, TWO_COMPLETE_EXECS as any);

    // [user, assistant(2 tool-calls), user(2 tool-results)]
    expect(out).toHaveLength(3);
    expect(out[1].role).toBe('assistant');
    expect(out[2].role).toBe('user');

    const results = out[2].content as Array<{ type: string; toolCallId: string; output: unknown; isError?: boolean }>;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.type === 'tool-result')).toBe(true);
    expect(results.map((r) => r.toolCallId).sort()).toEqual(['call_a', 'call_b']);
    const byId = Object.fromEntries(results.map((r) => [r.toolCallId, r]));
    expect(byId['call_a'].output).toEqual({ hits: 3 });
    expect(byId['call_a'].isError).toBe(false);
    expect(byId['call_b'].output).toEqual({ body: 'ok' });
  });

  it('does not append a tool-result message for non-tool assistant turns', () => {
    const textOnly = [
      { message_idx: 0, role: 'user' as const, content_blocks: [{ type: 'text', text: 'hi' }] },
      { message_idx: 1, role: 'assistant' as const, content_blocks: [{ type: 'text', text: 'hello' }] },
    ];
    const out = reconstructReplayMessages(textOnly as any, []);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.role !== 'user' || Array.isArray(m.content))).toBe(true);
  });

  it('synthesizes error results for failed / missing executions so the turn still validates', () => {
    const execs = [
      { message_idx: 1, tool_use_id: 'call_a', tool_name: 'search', status: 'failed' as const, output: null, error: 'boom' },
      // call_b has NO persisted execution (crash before result was written)
    ];
    const out = reconstructReplayMessages(TWO_PARALLEL_CALLS as any, execs as any);
    const results = out[2].content as Array<{ toolCallId: string; output: unknown; isError?: boolean }>;
    const byId = Object.fromEntries(results.map((r) => [r.toolCallId, r]));
    expect(byId['call_a'].isError).toBe(true);
    expect(byId['call_a'].output).toBe('boom');
    expect(byId['call_b'].isError).toBe(true);
    expect(byId['call_b'].output).toBe('tool result unavailable on replay');
  });

  it('the reconstructed history passes real AI SDK v6 generateText; the naive 1:1 map throws', async () => {
    const model = mockModel();

    // WITH the fix: re-paired history converts + validates against v6.
    const repaired = reconstructReplayMessages(TWO_PARALLEL_CALLS as any, TWO_COMPLETE_EXECS as any);
    const ok = await generateText({ model: model as any, messages: toModelMessages(repaired) as any });
    expect(ok.text).toBe('ok');

    // WITHOUT the fix: naive 1:1 map leaves the assistant's parallel tool-calls
    // unanswered → AI SDK v6 rejects (AI_MissingToolResultsError).
    const naive: ChatMessage[] = TWO_PARALLEL_CALLS.map((m) => ({
      role: m.role,
      content: m.content_blocks as any,
    }));
    await expect(
      generateText({ model: mockModel() as any, messages: toModelMessages(naive) as any }),
    ).rejects.toThrow(/tool result/i);
  });
});
