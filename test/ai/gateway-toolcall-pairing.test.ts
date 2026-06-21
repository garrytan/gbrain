import { describe, expect, it } from 'bun:test';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { repairToolPairing, toModelMessages, type ChatMessage } from '../../src/core/ai/gateway.ts';

// Regression guard for the dream-synthesis "Tool results are missing for tool
// calls: ..." crash (AI_MissingToolResultsError). An unbalanced history — an
// assistant tool-call with no following tool-result — hard-kills the subagent
// job AND every retry (the persisted history is replayed verbatim). These tests
// drive the REAL generateText with a MockLanguageModelV3 (no network/keys) so
// the AI SDK v6 invariant is exercised against the actual installed SDK.

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

describe('repairToolPairing (AI SDK v6 missing-tool-results recovery)', () => {
  it('is a no-op on an already-balanced history', () => {
    const balanced: ChatMessage[] = [
      { role: 'user', content: 'find foo' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'search', output: { hits: 3 } }] },
    ];
    expect(repairToolPairing(balanced)).toEqual(balanced);
  });

  it('synthesizes results when the assistant turn has no following tool message (crash/evict mid-turn)', () => {
    const orphaned: ChatMessage[] = [
      { role: 'user', content: 'find foo' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } }] },
    ];
    const repaired = repairToolPairing(orphaned);
    const tail = repaired[repaired.length - 1];
    expect(tail.role).toBe('user');
    const blocks = tail.content as Array<{ type: string; toolCallId: string; isError?: boolean }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'tool-result', toolCallId: 'tc1', isError: true });
  });

  it('back-fills only the missing IDs of a partial parallel batch (truncation / dropped IDs)', () => {
    const partial: ChatMessage[] = [
      { role: 'user', content: 'do three things' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 'search', input: {} },
          { type: 'tool-call', toolCallId: 'b', toolName: 'search', input: {} },
          { type: 'tool-call', toolCallId: 'c', toolName: 'search', input: {} },
        ],
      },
      // Only 'a' resolved — 'b' and 'c' were lost.
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'search', output: 'ok' }] },
    ];
    const repaired = repairToolPairing(partial);
    const toolMsg = repaired[2].content as Array<{ toolCallId: string; isError?: boolean }>;
    const ids = toolMsg.map((b) => b.toolCallId).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(toolMsg.find((b) => b.toolCallId === 'b')).toMatchObject({ isError: true });
    expect(toolMsg.find((b) => b.toolCallId === 'a')).not.toMatchObject({ isError: true });
    expect(repaired).toHaveLength(3); // merged in place, no extra message
  });

  it('lets the real AI SDK v6 generateText accept a previously-fatal unbalanced history', async () => {
    const unbalanced: ChatMessage[] = [
      { role: 'user', content: 'find foo' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } }] },
    ];
    // Without the repair this throws AI_MissingToolResultsError.
    const result = await generateText({
      model: mockModel() as any,
      messages: toModelMessages(repairToolPairing(unbalanced)) as any,
    });
    expect(result.text).toBe('ok');
  });
});
