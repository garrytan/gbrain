/**
 * Per-chunk synopsis prompt caching. Every chunk of a page is sent with the
 * same title and full document, so that part must sit in its own block with a
 * cache breakpoint and the chunk must come after it. With title, document and
 * chunk in one block, each call differs right after the instructions and
 * Anthropic writes a cache entry on every call without ever reading one.
 *
 * Asserts on the exact args handed to the `generateText` transport.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';
import { generatePerChunkSynopsis } from '../src/core/page-summary.ts';

const MODEL = 'anthropic:claude-haiku-4-5-20251001';

const baseArgs = {
  documentText: 'Full document text about acme-example fundraising.',
  pageTitle: 'Acme Example',
  pageSlug: 'companies/acme-example',
  sourceId: 'default',
  model: MODEL,
};

async function captureUserMessage(chunkText: string, chunkIndex: number): Promise<any> {
  let captured: any;
  __setGenerateTextTransportForTests(async (args: any) => {
    captured = args;
    return {
      content: [{ type: 'text', text: 'A one-sentence synopsis about the chunk.' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    } as any;
  });
  const result = await generatePerChunkSynopsis({ ...baseArgs, chunkText, chunkIndex });
  expect(result.kind).toBe('success');
  return captured.messages[0];
}

afterAll(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
});

beforeEach(() => {
  resetGateway();
  configureGateway({ chat_model: MODEL, env: { ANTHROPIC_API_KEY: 'fake' } });
});

describe('per-chunk synopsis prompt caching', () => {
  test('title and document ride in a cached leading block, the chunk comes last', async () => {
    const message = await captureUserMessage('The chunk text about the series A.', 0);
    expect(message.role).toBe('user');
    expect(message.content).toHaveLength(2);
    const [page, chunk] = message.content;
    expect(page.text).toContain('<page_title>Acme Example</page_title>');
    expect(page.text).toContain(baseArgs.documentText);
    expect(page.text).not.toContain('series A');
    expect(page.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    expect(chunk.text).toContain('The chunk text about the series A.');
    expect(chunk.providerOptions).toBeUndefined();
  });

  test('two chunks of one page send a byte-identical cached block', async () => {
    const first = await captureUserMessage('First chunk.', 0);
    const second = await captureUserMessage('Second chunk.', 1);
    expect(second.content[0]).toEqual(first.content[0]);
    expect(second.content[1].text).not.toBe(first.content[1].text);
  });
});
