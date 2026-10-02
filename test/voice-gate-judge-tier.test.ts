/**
 * #5165 (duplicates #5303, #5357): the voice-gate judge hardcoded the
 * Anthropic utility default, so installs without Anthropic credit failed every
 * gate. It now resolves the utility tier through the key-aware resolver.
 */

import { describe, test, expect, afterEach } from 'bun:test';

import { defaultJudge } from '../src/core/calibration/voice-gate.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatOpts } from '../src/core/ai/gateway.ts';
import { resolveTierDefault, TIER_DEFAULTS } from '../src/core/model-config.ts';
import { withEnv } from './helpers/with-env.ts';

afterEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
});

describe('#5165 voice-gate judge model', () => {
  test('an OpenAI-only install judges with the OpenAI utility model', async () => {
    await withEnv({ OPENAI_API_KEY: 'sk-fake', ANTHROPIC_API_KEY: undefined }, async () => {
      configureGateway({ env: { OPENAI_API_KEY: 'sk-fake' } });
      let model: string | undefined;
      __setChatTransportForTests(async (opts: ChatOpts) => {
        model = opts.model;
        return { text: '{"verdict":"conversational","reason":"ok"}', blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: opts.model ?? '', providerId: 'openai' } as never;
      });
      const verdict = await defaultJudge({ candidate: 'hey, quick note', mode: 'nudge' as never, rubric: 'be casual' });
      expect(verdict.verdict).toBe('conversational');
      const expected = resolveTierDefault('utility', { OPENAI_API_KEY: 'sk-fake' });
      expect(expected).not.toBe(TIER_DEFAULTS.utility);
      expect(model).toBe(expected);
    });
  });
});
