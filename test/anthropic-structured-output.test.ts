import { describe, it, expect } from 'bun:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, Output, jsonSchema } from 'ai';

// Claude Sonnet 5.5 and Opus 5.5 reject a forced tool_choice (`any` / `tool`)
// with a 400. When @ai-sdk/anthropic does not recognise a model as supporting
// native structured output, it emulates a JSON response with a forced `json`
// tool, which is exactly that forced tool_choice. Facts extraction (and every
// other `responseSchema` caller) then fails on every call. This pins the SDK
// behaviour gbrain relies on: a JSON-schema response goes out as
// `output_config.format`, with no tool_choice.
async function capturedBody(modelId: string): Promise<any> {
  let body: any = null;
  const provider = createAnthropic({
    apiKey: 'test-key',
    fetch: (async (_url: unknown, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: modelId,
        content: [{ type: 'text', text: '{"facts":[]}' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  await generateText({
    model: provider(modelId),
    prompt: 'extract',
    experimental_output: Output.object({
      schema: jsonSchema({
        type: 'object',
        properties: { facts: { type: 'array', items: { type: 'string' } } },
        required: ['facts'],
        additionalProperties: false,
      }),
    }),
  });
  return body;
}

describe('Anthropic JSON-schema responses use native structured output', () => {
  for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-opus-5']) {
    it(`${id}: output_config.format, no forced tool_choice`, async () => {
      const body = await capturedBody(id);
      expect(body?.output_config?.format).toBeDefined();
      expect(body?.tool_choice).toBeUndefined();
    });
  }
});
