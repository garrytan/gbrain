import { expect, test } from 'bun:test';
import { invokeAI, isAIInvocationPolicyError, withAIInvocationGuard, withAIInvocationPreflight } from '../../src/core/ai/invocation-guard.ts';

const call = { operation: 'test', kind: 'embedding' as const, model: 'test:model' };

test('preflight precedes parent admission and preserves its usage settlement', async () => {
  const events: string[] = [];
  const usage = { inputTokens: 12, outputTokens: 0 };
  await withAIInvocationGuard(async () => {
    events.push('admit');
    return { settle: async received => { expect(received).toBe(usage); events.push('settle'); } };
  }, () => withAIInvocationPreflight(async () => { events.push('policy'); }, () =>
    invokeAI(call, async () => { events.push('provider'); return 'ok'; }, () => usage)));
  expect(events).toEqual(['policy', 'admit', 'provider', 'settle']);
});

test('policy denial never reserves a parent permit, and parent refusal never calls the provider', async () => {
  const denied = new Error('policy denied');
  let admissions = 0, providers = 0;
  await expect(withAIInvocationGuard(async () => { admissions++; throw new Error('budget refused'); }, () =>
    withAIInvocationPreflight(async () => { throw denied; }, () => invokeAI(call, async () => { providers++; }, () => null))))
    .rejects.toBe(denied);
  expect(admissions).toBe(0);
  expect(providers).toBe(0);
  expect(isAIInvocationPolicyError(denied)).toBe(true);
  const budget = new Error('budget refused');
  await expect(withAIInvocationGuard(async () => { admissions++; throw budget; }, () =>
    withAIInvocationPreflight(async () => {}, () => invokeAI(call, async () => { providers++; }, () => null))))
    .rejects.toBe(budget);
  expect(admissions).toBe(1);
  expect(providers).toBe(0);
});

test('provider failure settles the original parent permit once with unknown usage', async () => {
  const failure = new Error('provider failed');
  const settlements: unknown[] = [];
  await expect(withAIInvocationGuard(async () => ({ settle: async usage => { settlements.push(usage); } }), () =>
    withAIInvocationPreflight(async () => {}, () => invokeAI(call, async () => { throw failure; }, () => null))))
    .rejects.toBe(failure);
  expect(settlements).toEqual([null]);
});

test('concurrent preflights and parent guards stay isolated and no-parent use remains valid', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const a: string[] = [], b: string[] = [];
  const first = withAIInvocationGuard(async () => { a.push('admit'); return { settle: async () => { a.push('settle'); } }; }, () =>
    withAIInvocationPreflight(async () => { a.push('policy'); entered.resolve(); await release.promise; }, () =>
      invokeAI(call, async () => { a.push('provider'); }, () => null)));
  await entered.promise;
  await withAIInvocationGuard(async () => { b.push('admit'); return { settle: async () => { b.push('settle'); } }; }, () =>
    withAIInvocationPreflight(async () => { b.push('policy'); }, () => invokeAI(call, async () => { b.push('provider'); }, () => null)));
  release.resolve();
  await first;
  expect(a).toEqual(['policy', 'admit', 'provider', 'settle']);
  expect(b).toEqual(['policy', 'admit', 'provider', 'settle']);
  expect(await withAIInvocationPreflight(async () => {}, () => invokeAI(call, async () => 'ok', () => null))).toBe('ok');
});
