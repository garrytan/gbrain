import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  __setChatTransportForTests,
  chat,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import {
  configureDailyBudget,
  resetDailyBudget,
} from '../../src/core/budget/daily-budget.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';

let engine: PGLiteEngine;

const RESULT: ChatResult = {
  text: 'ok',
  blocks: [{ type: 'text', text: 'ok' }],
  stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-sonnet-4-6',
  providerId: 'anthropic',
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  resetDailyBudget();
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetDailyBudget();
  resetGateway();
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: {} });
});

describe('database-backed gateway daily budget', () => {
  test('refuses before transport when projected spend exceeds the cap', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => { calls++; return RESULT; });
    configureDailyBudget(engine, 0.000001);

    await expect(chat({
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 4_096,
    })).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(0);
  });

  test('separate calls share pending and settled spend', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => { calls++; return RESULT; });
    configureDailyBudget(engine, 0.0002);

    await chat({ messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 });
    await expect(chat({
      messages: [{ role: 'user', content: 'hello again' }],
      maxTokens: 10,
    })).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(1);
  });
});
