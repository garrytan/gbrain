/**
 * Brainstorm model configurability (takeover of PR #1855 by @starm2010).
 *
 * - The cost preview + hard cost ceiling price the model that will actually
 *   run: --model override → configured chat_model → gateway fallback. Before
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
  test('--model override wins over config', () => {
    expect(resolveBrainstormChatModel({ chat_model: 'openai:gpt-5' }, 'anthropic:claude-opus-4-6'))
      .toBe('anthropic:claude-opus-4-6');
  });

  test('configured chat_model wins over the hardcoded fallback', () => {
    expect(resolveBrainstormChatModel({ chat_model: 'openai:gpt-5' }))
      .toBe('openai:gpt-5');
  });

  test('falls back to the gateway default model when nothing is configured', () => {
    expect(resolveBrainstormChatModel({})).toBe('anthropic:claude-sonnet-4-6');
  });
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
