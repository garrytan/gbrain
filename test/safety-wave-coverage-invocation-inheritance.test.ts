import { expect, test } from 'bun:test';
import { invokeAI, isAIInvocationPolicyError, withAIInvocationGuard, type AIInvocationGuard, type AIInvocationUsage } from '../src/core/ai/invocation-guard.ts';

const call = { operation: 'synthetic.audit', kind: 'embedding' as const, model: 'synthetic:model', maxInputTokens: 8 };
const usage = { inputTokens: 4, outputTokens: 0 };

function recordingGuard(name: string, events: Array<[string, AIInvocationUsage | null]>): AIInvocationGuard {
  return async () => {
    events.push([`${name}:admit`, null]);
    return { settle: async measured => { events.push([`${name}:settle`, measured]); } };
  };
}

test('inherited fact authorization admits and settles both budgets for one provider attempt', async () => {
  const events: Array<[string, AIInvocationUsage | null]> = [];
  let dispatched = 0;
  const result = await withAIInvocationGuard(recordingGuard('migration', events), () =>
    withAIInvocationGuard(recordingGuard('facts', events), () =>
      invokeAI(call, async () => { dispatched++; return 'synthetic-result'; }, () => usage), { inherit: true }));
  expect(result).toBe('synthetic-result');
  expect(dispatched).toBe(1);
  expect(events).toEqual([['migration:admit', null], ['facts:admit', null], ['migration:settle', usage], ['facts:settle', usage]]);
});

test('inner authorization refusal retains the outer debit without dispatching', async () => {
  const events: Array<[string, AIInvocationUsage | null]> = [];
  const refused = new Error('synthetic inner cap exhausted');
  let dispatched = false;
  await expect(withAIInvocationGuard(recordingGuard('migration', events), () =>
    withAIInvocationGuard(async () => { throw refused; }, () =>
      invokeAI(call, async () => { dispatched = true; }, () => usage), { inherit: true }))).rejects.toBe(refused);
  expect(dispatched).toBe(false);
  expect(isAIInvocationPolicyError(refused)).toBe(true);
  expect(events).toEqual([['migration:admit', null], ['migration:settle', null]]);
});

test('outer authorization refusal prevents inner admission and provider dispatch', async () => {
  const events: Array<[string, AIInvocationUsage | null]> = [];
  const refused = new Error('synthetic migration cap exhausted');
  let dispatched = false;
  await expect(withAIInvocationGuard(async () => { throw refused; }, () =>
    withAIInvocationGuard(recordingGuard('facts', events), () =>
      invokeAI(call, async () => { dispatched = true; }, () => usage), { inherit: true }))).rejects.toBe(refused);
  expect(dispatched).toBe(false);
  expect(events).toEqual([]);
  expect(isAIInvocationPolicyError(refused)).toBe(true);
});

test('uncertain provider failure settles both inherited permits without fabricated usage', async () => {
  const events: Array<[string, AIInvocationUsage | null]> = [];
  const timeout = new Error('synthetic transport timeout');
  await expect(withAIInvocationGuard(recordingGuard('migration', events), () =>
    withAIInvocationGuard(recordingGuard('facts', events), () =>
      invokeAI(call, async () => { throw timeout; }, () => usage), { inherit: true }))).rejects.toBe(timeout);
  expect(events).toEqual([['migration:admit', null], ['facts:admit', null], ['migration:settle', null], ['facts:settle', null]]);
  expect(isAIInvocationPolicyError(timeout)).toBe(false);
});

test('non-inheriting nested guards preserve the preexisting replacement contract', async () => {
  const events: Array<[string, AIInvocationUsage | null]> = [];
  await withAIInvocationGuard(recordingGuard('outer', events), () =>
    withAIInvocationGuard(recordingGuard('inner', events), () => invokeAI(call, async () => 'result', () => usage)));
  expect(events).toEqual([['inner:admit', null], ['inner:settle', usage]]);
});

test('inherit without a parent stays isolated from concurrent provider work', async () => {
  const events: Array<[string, AIInvocationUsage | null]> = [];
  await Promise.all([
    withAIInvocationGuard(recordingGuard('owned', events), async () => {
      await Promise.resolve();
      return invokeAI(call, async () => 'owned-result', () => usage);
    }, { inherit: true }),
    invokeAI(call, async () => 'unowned-result', () => usage),
  ]);
  expect(events).toEqual([['owned:admit', null], ['owned:settle', usage]]);
});
