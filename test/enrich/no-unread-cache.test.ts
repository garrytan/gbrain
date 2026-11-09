/**
 * enrich's write-up call asks for no prompt cache. Its system prompt is a short fixed rule set, below Anthropic's
 * minimum cacheable prefix, so the only breakpoint that took was the call-level auto-cache on the last block: the
 * page's own evidence, different on every call. Each write-up paid the 1.25x cache-write price on its whole prompt and
 * none was read back (a production brain: 17.9M cache-written tokens, 0 read, over 5,388 enrich calls in 30 days).
 * Hermetic: the exact generateText args via the gateway's transport seam, no network (a fake key satisfies setup).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { chat, configureGateway, resetGateway, __setGenerateTextTransportForTests } from '../../src/core/ai/gateway.ts';
import { defaultSynthesize } from '../../src/commands/enrich.ts';
import { buildEnrichPrompt } from '../../src/core/enrich/thin.ts';

const MODEL = 'anthropic:claude-sonnet-5-5';

afterEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
});

async function captureArgs(call: () => Promise<unknown>): Promise<any> {
  let captured: any;
  __setGenerateTextTransportForTests(async (args: any) => {
    captured = args;
    return { content: [{ type: 'text', text: '## Summary\nA write-up.' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
  });
  configureGateway({ chat_model: MODEL, env: { ANTHROPIC_API_KEY: 'fake' } });
  await call();
  expect(captured).toBeDefined();
  return captured;
}

describe('enrich write-up call', () => {
  test('sends no cache breakpoint: none on the call, none on the system block', async () => {
    const { system, user } = buildEnrichPrompt({
      slug: 'people/ada', title: 'Ada', kind: 'person', currentBody: '',
      evidence: [{ source_slug: 'meetings/kickoff', text: 'Ada leads the shuttle program.' }],
    });
    const args = await captureArgs(() => defaultSynthesize({ system, user, model: MODEL }));
    expect(JSON.stringify(args.messages)).toContain('Ada leads the shuttle program.');   // the evidence went out
    expect(args.providerOptions?.anthropic?.cacheControl).toBeUndefined();
    expect(typeof args.system).toBe('string');                     // a bare string carries no per-block breakpoint
    expect(args.system).toBe(system);
    expect(JSON.stringify(args.messages)).not.toContain('cacheControl');
  });

  test('the same capture sees both breakpoints when a caller does ask for the cache', async () => {
    const args = await captureArgs(() => chat({ model: MODEL, system: 'rules', messages: [{ role: 'user', content: 'evidence' }], cacheSystem: true }));
    expect(args.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
    expect(args.system?.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
  });
});
