/**
 * Pins `repairToolPairing` (the chat()-boundary safety net) and proves, against
 * the REAL AI SDK v6 `generateText`, that the two failure modes this wave fixes
 * are gone:
 *   - an unbalanced tool history (assistant tool-call with no tool-result) is
 *     back-filled so v6 no longer throws AI_MissingToolResultsError, and
 *   - a Date-bearing tool-result (Postgres timestamptz) passes v6's ModelMessage
 *     JSONValue schema after `toModelMessages` ISO-izes it, whereas a raw Date
 *     is still rejected (control).
 *
 * MockLanguageModelV3 = no network / no keys.
 */
import { describe, expect, it } from 'bun:test';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { repairToolPairing, toModelMessages, type ChatMessage } from '../../src/core/ai/gateway.ts';

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

describe('repairToolPairing', () => {
  it('is a no-op on a balanced history', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { ok: 1 } }] },
    ];
    expect(repairToolPairing(msgs)).toEqual(msgs);
  });

  it('synthesizes a tool-result turn when the assistant tool-call is fully unanswered', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} }] },
    ];
    const out = repairToolPairing(msgs);
    expect(out).toHaveLength(2);
    expect(out[1].role).toBe('user');
    const block = (out[1].content as any[])[0];
    expect(block).toMatchObject({ type: 'tool-result', toolCallId: 'c1', isError: true });
  });

  it('merges stubs into a PARTIALLY-answered turn without duplicating the answered id', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'a', toolName: 'search', input: {} },
        { type: 'tool-call', toolCallId: 'b', toolName: 'search', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'search', output: { ok: 1 } }] },
    ];
    const out = repairToolPairing(msgs);
    expect(out).toHaveLength(2); // merged in place, not appended
    const ids = (out[1].content as any[]).map((x) => x.toolCallId);
    expect(ids).toEqual(['a', 'b']); // 'a' kept once, 'b' back-filled
    expect((out[1].content as any[]).filter((x) => x.toolCallId === 'a')).toHaveLength(1);
  });
});

describe('real AI SDK v6 validation', () => {
  it('an unbalanced history passes generateText after repairToolPairing', async () => {
    const model = mockModel();
    const unbalanced: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} }] },
      // no tool-result turn
    ];
    const result = await generateText({
      model: model as any,
      messages: toModelMessages(repairToolPairing(unbalanced)) as any,
    });
    expect(result.text).toBe('ok');
    const prompt = model.doGenerateCalls[0]!.prompt as any[];
    expect(prompt.some((m) => m.role === 'tool')).toBe(true); // stub promoted to tool role
  });

  it('a Date-bearing tool-result passes after toModelMessages ISO-izes it; a raw Date is rejected', async () => {
    const withDate: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'brain_get_page', input: {} }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'brain_get_page', output: { updated_at: new Date('2026-06-26T06:56:59.000Z') } }] },
    ];
    // Fixed path: converted history validates.
    await expect(generateText({ model: mockModel() as any, messages: toModelMessages(withDate) as any })).resolves.toBeDefined();

    // Control: a raw Date placed straight into a v6 ModelMessage json value is rejected.
    const rawDateMessages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'brain_get_page', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'brain_get_page', output: { type: 'json', value: { updated_at: new Date('2026-06-26T06:56:59.000Z') } } }] },
    ];
    await expect(generateText({ model: mockModel() as any, messages: rawDateMessages as any })).rejects.toThrow();
  });
});
