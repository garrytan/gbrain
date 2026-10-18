/**
 * PR #6341 takeover — the per-chunk synopsis prompt must put the page
 * document on its own cacheable block.
 *
 * `generatePerChunkSynopsis` sent ONE user string holding the title, the
 * (up to 32K-char) document and the chunk. The only explicit Anthropic
 * breakpoint `chat()` placed was the ~190-token system block, which is below
 * every published minimum cacheable length, and the call-level auto marker
 * lands on the varying tail. So every chunk of the same page WROTE a fresh
 * cache entry and never READ one.
 *
 * Fix under test: the prompt is two text blocks — a stable `{title,
 * document}` block flagged `cache: true` and a per-chunk block — and
 * `toModelMessages` turns that flag into the block's
 * `providerOptions.anthropic.cacheControl` ONLY when the call has a
 * cache-control value (Anthropic-class route with `cacheSystem`). Non-caching
 * routes see plain text blocks; the claude-cli adapter joins text parts with
 * '\n', so the rendered prompt text is byte-identical to the old string and
 * `SYNOPSIS_PROMPT_VERSION` stays at 1.
 *
 * These cases inspect the exact args handed to the `generateText` transport,
 * the same way `test/ai/gateway-cache-breakpoint.test.ts` does.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  chat,
  configureGateway,
  resetGateway,
  toModelMessages,
  __setChatTransportForTests,
  __setGenerateTextTransportForTests,
  type ChatOpts,
  type ChatBlock,
} from '../src/core/ai/gateway.ts';
import {
  generatePerChunkSynopsis,
  SYNOPSIS_PROMPT_VERSION,
} from '../src/core/page-summary.ts';

const pageArgs = {
  documentText: 'Full document text about acme-example fundraising.\n\nA second paragraph.',
  pageTitle: 'Acme Example',
  pageSlug: 'companies/acme-example',
  sourceId: 'default',
};

/** The single string the synopsis prompt was before the split — the token stream to preserve. */
function legacyPrompt(title: string, document: string, chunk: string): string {
  return [
    `<page_title>${title}</page_title>`,
    '',
    '<full_document>',
    document,
    '</full_document>',
    '',
    '<chunk>',
    chunk,
    '</chunk>',
    '',
    'Write the one-sentence synopsis for <chunk>:',
  ].join('\n');
}

function textBlocks(content: string | ChatBlock[]): Array<Extract<ChatBlock, { type: 'text' }>> {
  if (typeof content === 'string') throw new Error(`expected text blocks, got a string: ${content.slice(0, 40)}…`);
  return content.filter((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text');
}

afterAll(() => {
  resetGateway();
  __setChatTransportForTests(null);
  __setGenerateTextTransportForTests(null);
});

describe('generatePerChunkSynopsis prompt shape', () => {
  beforeEach(() => {
    resetGateway();
    __setChatTransportForTests(null);
    __setGenerateTextTransportForTests(null);
  });

  async function captureChatOpts(chunkText: string, chunkIndex: number): Promise<ChatOpts> {
    const captured: ChatOpts[] = [];
    __setChatTransportForTests(async (opts: ChatOpts) => {
      captured.push(opts);
      return {
        text: 'A one-sentence synopsis about the chunk.',
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:stub',
        providerId: 'anthropic',
      };
    });
    const result = await generatePerChunkSynopsis({ ...pageArgs, chunkText, chunkIndex });
    expect(result.kind).toBe('success');
    expect(captured).toHaveLength(1);
    return captured[0]!;
  }

  test('two user text blocks: the page block (title + document) is flagged cache: true, the chunk block is not', async () => {
    const opts = await captureChatOpts('The chunk text about the series A.', 0);
    expect(opts.messages).toHaveLength(1);
    expect(opts.messages[0]!.role).toBe('user');
    const blocks = textBlocks(opts.messages[0]!.content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.cache).toBe(true);
    expect(blocks[0]!.text).toContain('<page_title>Acme Example</page_title>');
    expect(blocks[0]!.text).toContain(pageArgs.documentText);
    expect(blocks[0]!.text).not.toContain('<chunk>');
    expect(blocks[1]!.cache).toBeUndefined();
    expect(blocks[1]!.text).toContain('<chunk>\nThe chunk text about the series A.\n</chunk>');
    expect(blocks[1]!.text).not.toContain('<full_document>');
    expect(opts.cacheSystem).toBe(true);
  });

  test('the blocks joined with a newline are byte-identical to the previous single-string prompt; the prompt version is unchanged', async () => {
    const chunk = 'The chunk text about the series A.';
    const opts = await captureChatOpts(chunk, 0);
    const rendered = textBlocks(opts.messages[0]!.content).map(b => b.text).join('\n');
    expect(rendered).toBe(legacyPrompt(pageArgs.pageTitle, pageArgs.documentText, chunk));
    expect(SYNOPSIS_PROMPT_VERSION).toBe(1);
  });

  test('two chunks of one page share a byte-identical page block and differ only in the chunk block', async () => {
    const a = textBlocks((await captureChatOpts('First chunk.', 0)).messages[0]!.content);
    const b = textBlocks((await captureChatOpts('Second chunk.', 1)).messages[0]!.content);
    expect(a[0]!.text).toBe(b[0]!.text);
    expect(a[1]!.text).not.toBe(b[1]!.text);
  });

  test('a document over the synopsis budget is truncated inside the page block, so the cached prefix is bounded', async () => {
    const { SYNOPSIS_DOC_MAX_CHARS } = await import('../src/core/page-summary.ts');
    const captured: ChatOpts[] = [];
    __setChatTransportForTests(async (opts: ChatOpts) => {
      captured.push(opts);
      return {
        text: 'ok', blocks: [], stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:stub', providerId: 'anthropic',
      };
    });
    await generatePerChunkSynopsis({ ...pageArgs, documentText: 'x'.repeat(SYNOPSIS_DOC_MAX_CHARS + 500), chunkText: 'c', chunkIndex: 0 });
    const [page, chunk] = textBlocks(captured[0]!.messages[0]!.content);
    expect(page!.text).toContain('chars truncated for synopsis budget');
    expect(page!.text.length).toBeLessThan(SYNOPSIS_DOC_MAX_CHARS + 200);
    expect(chunk!.text).not.toContain('truncated');
  });
});

describe('chat() wire shape for a cache-flagged text block', () => {
  beforeEach(() => {
    resetGateway();
    __setChatTransportForTests(null);
    __setGenerateTextTransportForTests(null);
  });

  const twoBlockMessage = (): ChatOpts['messages'] => [{
    role: 'user',
    content: [
      { type: 'text', text: '<page_title>T</page_title>\n\n<full_document>\nD\n</full_document>', cache: true },
      { type: 'text', text: '\n<chunk>\nC\n</chunk>\n\nWrite the one-sentence synopsis for <chunk>:' },
    ],
  }];

  async function captureWire(model: string, env: Record<string, string>, opts: Partial<ChatOpts> = {}, cfg: Record<string, unknown> = {}): Promise<any> {
    let captured: any;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args;
      return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    configureGateway({ chat_model: model, env, ...cfg } as any);
    await chat({ model, system: 'SYS', cacheSystem: true, messages: twoBlockMessage(), ...opts });
    return captured;
  }

  test('Anthropic + cacheSystem: the page block carries the same cacheControl as the system block; the chunk block carries none; the `cache` flag never reaches the wire', async () => {
    const args = await captureWire('anthropic:claude-sonnet-4-6', { ANTHROPIC_API_KEY: 'fake' });
    const systemCc = (args.system as any)?.providerOptions?.anthropic?.cacheControl;
    expect(systemCc).toEqual({ type: 'ephemeral' });
    const [page, chunk] = args.messages[0].content;
    expect(page).toEqual({
      type: 'text',
      text: '<page_title>T</page_title>\n\n<full_document>\nD\n</full_document>',
      providerOptions: { anthropic: { cacheControl: systemCc } },
    });
    expect(chunk).toEqual({ type: 'text', text: '\n<chunk>\nC\n</chunk>\n\nWrite the one-sentence synopsis for <chunk>:' });
    expect('cache' in page).toBe(false);
    // Explicit breakpoints in this request: system + page block (+ none for
    // tools) = 2, plus the call-level auto marker — within Anthropic's four.
    expect(args.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
  });

  test('a configured cacheControl TTL override reaches the page block too (one canonical value per request)', async () => {
    const args = await captureWire('anthropic:claude-sonnet-4-6', { ANTHROPIC_API_KEY: 'fake' }, {}, {
      provider_chat_options: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    });
    expect(args.messages[0].content[0].providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } });
  });

  test('Anthropic without cacheSystem: plain text blocks, no providerOptions, no `cache` key', async () => {
    const args = await captureWire('anthropic:claude-sonnet-4-6', { ANTHROPIC_API_KEY: 'fake' }, { cacheSystem: false });
    expect(typeof args.system).toBe('string');
    for (const part of args.messages[0].content) {
      expect(Object.keys(part).sort()).toEqual(['text', 'type']);
    }
  });

  test('a recipe that declares no prompt caching gets plain text blocks even with cacheSystem: true', async () => {
    const { getProviderCapabilities } = await import('../src/core/ai/capabilities.ts');
    expect(getProviderCapabilities('google:gemini-1.5-pro').supportsPromptCaching).toBe(false);
    const args = await captureWire('google:gemini-1.5-pro', { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' });
    expect(typeof args.system).toBe('string');
    for (const part of args.messages[0].content) {
      expect(Object.keys(part).sort()).toEqual(['text', 'type']);
    }
  });
});

describe('toModelMessages honours `cache: true` only with a cache-control value', () => {
  const msgs = (): ChatOpts['messages'] => [{
    role: 'user',
    content: [
      { type: 'text', text: 'stable', cache: true, providerMetadata: { openai: { itemId: 'x' } } },
      { type: 'text', text: 'varying' },
    ],
  }];

  test('no cache-control value: the flag is dropped and captured providerMetadata still round-trips', () => {
    expect(toModelMessages(msgs())).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'stable', providerOptions: { openai: { itemId: 'x' } } },
        { type: 'text', text: 'varying' },
      ],
    }]);
  });

  test('with a cache-control value: the anthropic breakpoint is merged next to existing providerOptions on the flagged block only', () => {
    expect(toModelMessages(msgs(), { type: 'ephemeral', ttl: '1h' })).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'stable', providerOptions: { openai: { itemId: 'x' }, anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } },
        { type: 'text', text: 'varying' },
      ],
    }]);
  });

  test('a string message and assistant blocks are untouched by the value', () => {
    const input: ChatOpts['messages'] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(toModelMessages(input, { type: 'ephemeral' })).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });
});
