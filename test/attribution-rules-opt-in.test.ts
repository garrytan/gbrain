/**
 * #5425: the speaker/withdrawal prompt rules proposed by @clatyceo are
 * opt-in (a matched run measured no benefit and a small cat15 recall drop).
 * Default prompts are unchanged; the config keys add the rules, and
 * propose-takes caches opt-in extractions under their own prompt version.
 */
import { describe, expect, test } from 'bun:test';
import { __testing } from '../src/core/cycle/synthesize.ts';
import { defaultExtractor, EXTRACT_TAKES_ATTRIBUTION_RULES } from '../src/core/cycle/propose-takes.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatOpts } from '../src/core/ai/gateway.ts';

const transcript = { filePath: '/t/x.txt', basename: 'x', content: 'User: hi', contentHash: 'a'.repeat(64) };

describe('attribution rules are opt-in (#5425)', () => {
  test('the synthesis prompt carries rule 8 only when enabled', () => {
    const build = (on: boolean) => __testing.buildSynthesisPrompt(transcript as never, 'User: hi', 0, 1, '', 'wiki', '', '', [], undefined, undefined, 'oneshot', '2026-09-29', on);
    expect(build(false)).not.toContain('Keep the speaker and source timing explicit');
    expect(build(true)).toContain('8. Keep the speaker and source timing explicit');
  });

  test('the propose-takes extractor adds the rules only when enabled', async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-test' } } as never);
    const prompts: string[] = [];
    __setChatTransportForTests(async (o: ChatOpts) => {
      prompts.push(String(o.messages?.[0]?.content ?? ''));
      return { text: '[]', blocks: [{ type: 'text', text: '[]' }], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: o.model ?? 'x', providerId: 'anthropic' };
    });
    try {
      const input = { pagePath: 'wiki/x', pageBody: 'Some prose.', existingTakes: [] };
      await defaultExtractor(input);
      await defaultExtractor({ ...input, attributionRules: true });
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
    }
    expect(prompts[0]).not.toContain(EXTRACT_TAKES_ATTRIBUTION_RULES.trim());
    expect(prompts[1]).toContain(EXTRACT_TAKES_ATTRIBUTION_RULES.trim());
  });
});
