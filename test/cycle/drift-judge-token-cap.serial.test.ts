import { describe, it, expect, mock, afterAll } from 'bun:test';
import { THINKING_MODEL_MAX_OUTPUT_TOKENS } from '../../src/core/ai/gateway.ts';

// drift resolves its model at tier 'reasoning' (models.drift), threads it into
// defaultDriftJudge as modelHint, and caps the verdict envelope. A thinking
// model handed a 400-token cap spends it on reasoning and returns empty
// content with finish_reason "length" — the judge then reports
// judge_output_parse_failed, i.e. "no drift" at zero confidence, so the failure
// is indistinguishable from a clean audit.
//
// defaultDriftJudge resolves `chat` through a dynamic import, so mocking the
// gateway module captures the cap actually sent.
const calls: Array<{ model?: string; maxTokens?: number }> = [];
const actual = await import('../../src/core/ai/gateway.ts');

mock.module('../../src/core/ai/gateway.ts', () => ({
  ...actual,
  chat: async (opts: { model?: string; maxTokens?: number }) => {
    calls.push({ model: opts.model, maxTokens: opts.maxTokens });
    return { text: '{"drifted":false,"confidence":0.1,"reasoning":"stub"}' };
  },
}));

const { defaultDriftJudge } = await import('../../src/core/cycle/drift.ts');
afterAll(() => mock.restore());

const candidate = { claim: 'c', weight: 1, pageSlug: 'p' } as any;
const run = async (modelHint?: string) => {
  calls.length = 0;
  await defaultDriftJudge({ candidate, evidence: 'e', modelHint });
  return calls[0];
};

describe('drift judge output cap', () => {
  it('keeps the 400-token answer budget for a non-thinking model', async () => {
    expect((await run('groq:qwen/qwen3.8-27b'))?.maxTokens).toBe(400);
  });

  it('grants the shared cap when models.drift resolves to a thinking model', async () => {
    expect((await run('deepseek:deepseek-v4-flash'))?.maxTokens)
      .toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
  });

  it('keeps 400 when no model hint is supplied', async () => {
    expect((await run(undefined))?.maxTokens).toBe(400);
  });
});
