/**
 * Brainstorm model configurability (takeover of PR #1855 by @starm2010).
 *
 * - The cost preview + hard cost ceiling price the model that will actually
 *   run: --model override → configured gateway chat model → file chat_model →
 *   gateway fallback. Before
 *   this, the preview always priced anthropic:claude-sonnet-4-6 even when
 *   the configured chat_model was something else.
 * - The judge phase honors the `models.brainstorm.judge` config key when no
 *   --judge-model flag is passed.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolveBrainstormChatModel,
  resolveBrainstormJudgeModel,
} from '../../src/core/brainstorm/orchestrator.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

function mockEngine(configValues: Record<string, string>): { engine: BrainEngine; reads: string[] } {
  const reads: string[] = [];
  const engine = {
    async getConfig(key: string): Promise<string | null> {
      reads.push(key);
      return configValues[key] ?? null;
    },
  } as unknown as BrainEngine;
  return { engine, reads };
}

describe('resolveBrainstormChatModel', () => {
  // Precedence: --model override, then the configured gateway chat model
  // (#5873: it carries the DB-plane models.tier.* overrides), then the file
  // chat_model, then the hardcoded gateway fallback.
  const CASES: Array<{ name: string; config: { chat_model?: string }; override?: string; gateway?: string | null; want: string }> = [
    { name: '--model override wins over config', config: { chat_model: 'openai:gpt-5' }, override: 'anthropic:claude-opus-4-6', want: 'anthropic:claude-opus-4-6' },
    { name: '--model override wins over the gateway model', config: { chat_model: 'openai:gpt-5' }, override: 'anthropic:claude-opus-4-6', gateway: 'claude-cli:opus', want: 'anthropic:claude-opus-4-6' },
    { name: 'the gateway model wins over the file chat_model', config: { chat_model: 'openai:gpt-5' }, gateway: 'claude-cli:opus', want: 'claude-cli:opus' },
    { name: 'configured chat_model wins over the hardcoded fallback', config: { chat_model: 'openai:gpt-5' }, want: 'openai:gpt-5' },
    { name: 'an unconfigured gateway (null) falls through to the file chat_model', config: { chat_model: 'openai:gpt-5' }, gateway: null, want: 'openai:gpt-5' },
    { name: 'falls back to the gateway default model when nothing is configured', config: {}, want: 'anthropic:claude-sonnet-4-6' },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      expect(resolveBrainstormChatModel(c.config, c.override, c.gateway)).toBe(c.want);
    });
  }
});

describe('resolveBrainstormJudgeModel', () => {
  test('--judge-model flag wins without touching config', async () => {
    const { engine, reads } = mockEngine({ 'models.brainstorm.judge': 'openai:gpt-5' });
    const out = await resolveBrainstormJudgeModel(engine, 'anthropic:claude-opus-4-6');
    expect(out).toBe('anthropic:claude-opus-4-6');
    expect(reads).toHaveLength(0);
  });

  test('models.brainstorm.judge config key is honored when no flag is passed', async () => {
    const { engine, reads } = mockEngine({ 'models.brainstorm.judge': 'openai:gpt-5' });
    const out = await resolveBrainstormJudgeModel(engine);
    expect(out).toBe('openai:gpt-5');
    expect(reads).toEqual(['models.brainstorm.judge']);
  });

  test('returns undefined (defer to modelOverride / gateway default) when unset', async () => {
    const { engine } = mockEngine({});
    expect(await resolveBrainstormJudgeModel(engine)).toBeUndefined();
  });
});
