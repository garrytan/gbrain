/**
 * #5357 — the voice-gate judge must resolve its model through
 * `resolveTierDefault('utility')`, not the literal `TIER_DEFAULTS.utility`
 * Anthropic floor. On a single-provider install (no ANTHROPIC_API_KEY) the
 * literal call hard-fails before calibration_profile can run even though a
 * servable tier pin exists.
 *
 * Serial: mock.module on the gateway + process.env key mutation (same
 * isolation rationale as the other *.serial gateway-mock files — the module
 * registry and env are process-global).
 */

import { describe, test, expect, mock } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';

const chatCalls: Array<{ model?: string }> = [];

mock.module('../src/core/ai/gateway.ts', () => ({
  chat: async (opts: { model?: string }) => {
    chatCalls.push({ model: opts.model });
    return { text: '{"verdict":"conversational","reason":"ok"}' };
  },
  isAvailable: () => true,
}));

const { defaultJudge } = await import('../src/core/calibration/voice-gate.ts');
const { resolveTierDefault, TIER_DEFAULTS } = await import('../src/core/model-config.ts');

describe('#5357 — defaultJudge tier resolution', () => {
  test('uses resolveTierDefault(utility), not the Anthropic literal', async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: 'sk-test-openai' }, async () => {
      const resolved = resolveTierDefault('utility');
      // Prove the environment discriminates: tier resolution lands on the
      // openai walk, NOT the Anthropic floor the old literal pinned.
      expect(resolved).not.toBe(TIER_DEFAULTS.utility);

      chatCalls.length = 0;
      const verdict = await defaultJudge({ candidate: 'hey, quick status check', mode: 'nudge', rubric: 'rubric' });
      expect(verdict.verdict).toBe('conversational');
      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0]!.model).toBe(resolved);
    });
  });

  test('keyed installs keep the Anthropic tier default', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: undefined }, async () => {
      chatCalls.length = 0;
      await defaultJudge({ candidate: 'hey', mode: 'nudge', rubric: 'rubric' });
      expect(chatCalls[0]!.model).toBe(resolveTierDefault('utility'));
      expect(chatCalls[0]!.model).toBe(TIER_DEFAULTS.utility);
    });
  });
});
