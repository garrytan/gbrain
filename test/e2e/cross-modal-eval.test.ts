/**
 * E2E for `gbrain eval cross-modal` runner via mocked gateway chat().
 *
 * Lives under test/e2e/ so the test-isolation lint (R2 — mock.module quarantine)
 * does not require a *.serial.test.ts rename: test/e2e/* is exempt from the
 * lint, and `scripts/run-e2e.sh` already runs one file per Bun process so
 * `mock.module` leaks are contained.
 *
 * Verifies the verdict / exit-code contract end-to-end:
 *   PASS         (verdict='pass') when every dim mean >=7 and no model <5
 *   FAIL         (verdict='fail') when any dim breaches mean OR floor
 *   INCONCLUSIVE (verdict='inconclusive') when <2/3 model calls succeed
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { configureGateway } from '../../src/core/ai/gateway.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gbrain-cme-e2e-'));
  // Configure the gateway so our mock can pretend providers are available.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    expansion_model: 'anthropic:claude-haiku-4-5-20251001',
    chat_model: 'anthropic:claude-sonnet-4-6-20250929',
    base_urls: undefined,
    env: {
      OPENAI_API_KEY: 'sk-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GOOGLE_GENERATIVE_AI_API_KEY: 'sk-google-test',
    },
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  mock.restore();
});

function makeChatStub(scoresBySlot: Record<string, number[]>) {
  let callIdx = 0;
  const order = ['openai:gpt-4o', 'anthropic:claude-opus-4-7', 'google:gemini-1.5-pro'];
  return mock(async (opts: { model?: string }) => {
    const model = opts.model ?? '';
    callIdx++;
    const slotIdx = order.indexOf(model);
    const scores = scoresBySlot[model];
    if (!scores) {
      throw new Error(`mock: no scores configured for model ${model}`);
    }
    const goal = scores[0]!;
    const depth = scores[1]!;
    return {
      text: JSON.stringify({
        scores: { goal: { score: goal }, depth: { score: depth } },
        overall: (goal + depth) / 2,
        improvements: [`${slotIdx + 1}. tighten the intro`],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model,
      providerId: model.split(':')[0]!,
    };
  });
}

describe('gbrain eval cross-modal — runner verdict contract', () => {
  test('PASS: 3 happy responses, all dims >=7', async () => {
    const chatStub = makeChatStub({
      'openai:gpt-4o': [9, 8],
      'anthropic:claude-opus-4-7': [8, 7],
      'google:gemini-1.5-pro': [8, 8],
    });
    mock.module('../../src/core/ai/gateway.ts', () => ({
      chat: chatStub,
      configureGateway,
      isAvailable: () => true,
    }));

    const { runEval } = await import('../../src/core/cross-modal-eval/runner.ts');
    const result = await runEval({
      task: 'sample task',
      output: 'sample output content',
      slug: 'demo',
      receiptDir: tempDir,
      cycles: 1,
    });

    expect(result.finalAggregate.verdict).toBe('pass');
    expect(result.cycles).toHaveLength(1);
    const files = readdirSync(tempDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]!.startsWith('demo-')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(tempDir, files[0]!), 'utf-8'));
    expect(receipt.schema_version).toBe(1);
    expect(receipt.aggregate.verdict).toBe('pass');
  });

  test('FAIL: one dim mean below 7', async () => {
    const chatStub = makeChatStub({
      'openai:gpt-4o': [9, 6],
      'anthropic:claude-opus-4-7': [8, 6],
      'google:gemini-1.5-pro': [8, 6],
    });
    mock.module('../../src/core/ai/gateway.ts', () => ({
      chat: chatStub,
      configureGateway,
      isAvailable: () => true,
    }));

    const { runEval } = await import('../../src/core/cross-modal-eval/runner.ts');
    const result = await runEval({
      task: 'sample task',
      output: 'sample output content',
      slug: 'demo',
      receiptDir: tempDir,
      cycles: 1,
    });

    expect(result.finalAggregate.verdict).toBe('fail');
    expect(result.finalAggregate.dimensions.depth!.failReason).toBe('mean_below_7');
  });

  test('FAIL: min-score floor caught when one model scores <5 (Q2)', async () => {
    const chatStub = makeChatStub({
      'openai:gpt-4o': [9, 8],
      'anthropic:claude-opus-4-7': [8, 8],
      'google:gemini-1.5-pro': [4, 8], // goal=4 trips the floor
    });
    mock.module('../../src/core/ai/gateway.ts', () => ({
      chat: chatStub,
      configureGateway,
      isAvailable: () => true,
    }));

    const { runEval } = await import('../../src/core/cross-modal-eval/runner.ts');
    const result = await runEval({
      task: 'sample task',
      output: 'sample output content',
      slug: 'demo',
      receiptDir: tempDir,
      cycles: 1,
    });

    expect(result.finalAggregate.verdict).toBe('fail');
    expect(result.finalAggregate.dimensions.goal!.failReason).toBe('min_below_5');
  });

  test('INCONCLUSIVE: 2 of 3 mock 5xx -> exit 2 contract (Q3)', async () => {
    const chatStub = mock(async (opts: { model?: string }) => {
      if (opts.model === 'openai:gpt-4o') {
        return {
          text: JSON.stringify({
            scores: { goal: { score: 8 } },
            improvements: ['1. ok'],
          }),
          blocks: [],
          stopReason: 'end',
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: opts.model,
          providerId: 'openai',
        };
      }
      throw new Error(`mock: forced 5xx for ${opts.model}`);
    });
    mock.module('../../src/core/ai/gateway.ts', () => ({
      chat: chatStub,
      configureGateway,
      isAvailable: () => true,
    }));

    const { runEval } = await import('../../src/core/cross-modal-eval/runner.ts');
    const result = await runEval({
      task: 'sample task',
      output: 'sample output content',
      slug: 'demo',
      receiptDir: tempDir,
      cycles: 1,
    });

    expect(result.finalAggregate.verdict).toBe('inconclusive');
    expect(result.finalAggregate.successes).toBe(1);
    expect(result.finalAggregate.failures).toBe(2);
    // Receipt is still written even on INCONCLUSIVE — forensics path.
    const files = readdirSync(tempDir);
    expect(files.length).toBe(1);
    const receipt = JSON.parse(readFileSync(join(tempDir, files[0]!), 'utf-8'));
    expect(receipt.aggregate.verdict).toBe('inconclusive');
    expect(receipt.aggregate.errors).toHaveLength(2);
  });
});
