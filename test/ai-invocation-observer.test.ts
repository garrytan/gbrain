import { afterEach, describe, expect, test } from 'bun:test';
import {
  aiInvocationObserverFailures,
  currentAIAttribution,
  invokeAI,
  observeAIInvocations,
  sdkInvocationUsage,
  withAIAttribution,
  withAIInvocationGuard,
  type AIInvocationEvent,
} from '../src/core/ai/invocation-guard.ts';
import { createGuardedGeneration } from '../src/core/ai/guarded-generation.ts';

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

function observe(): AIInvocationEvent[] {
  const events: AIInvocationEvent[] = [];
  disposers.push(observeAIInvocations(e => { events.push(e); }));
  return events;
}

const chat = { operation: 'test.chat', kind: 'chat' as const, model: 'anthropic:claude-sonnet-4-6' };

describe('invocation observers', () => {
  test('an unguarded call is observed with its usage and outcome', async () => {
    const events = observe();
    await invokeAI(chat, async () => ({ usage: { inputTokens: 10, outputTokens: 3 } }), sdkInvocationUsage);
    await expect(invokeAI(chat, async () => { throw new Error('boom'); }, sdkInvocationUsage)).rejects.toThrow('boom');
    expect(events.map(e => e.outcome)).toEqual(['ok', 'error']);
    expect(events[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(events[1]!.usage).toBeNull();
  });

  test('a guard refusal is observed as refused and still throws', async () => {
    const events = observe();
    await expect(withAIInvocationGuard(async () => { throw new Error('over budget'); },
      () => invokeAI(chat, async () => 'never', () => null))).rejects.toThrow('over budget');
    expect(events.map(e => e.outcome)).toEqual(['refused']);
  });

  test('observation leaves generation options untouched; a guard still pins its own', async () => {
    const seen: any[] = [];
    const generate = createGuardedGeneration(() => 4096);
    const transport = async (opts: any) => { seen.push(opts); return { usage: { inputTokens: 1, outputTokens: 1 } }; };
    const events = observe();
    await generate('anthropic:claude-sonnet-4-6', transport, { prompt: 'x' });
    expect(seen[0]).toEqual({ prompt: 'x' });
    expect(events).toHaveLength(1);
    await withAIInvocationGuard(async () => ({ settle: async () => {} }),
      () => generate('anthropic:claude-sonnet-4-6', transport, { prompt: 'y' }));
    expect(seen[1]).toMatchObject({ prompt: 'y', maxRetries: 0, maxOutputTokens: 4096 });
  });

  test('without observers the transport is called directly with the caller options', async () => {
    const seen: any[] = [];
    await createGuardedGeneration(() => 4096)('m', async (opts: any) => { seen.push(opts); return {}; }, { prompt: 'z' });
    expect(seen[0]).toEqual({ prompt: 'z' });
  });

  test('a throwing observer never reaches the call; failures are counted', async () => {
    const before = aiInvocationObserverFailures();
    disposers.push(observeAIInvocations(() => { throw new Error('observer bug'); }));
    const events = observe();
    await expect(invokeAI(chat, async () => 'ok', () => null)).resolves.toBe('ok');
    expect(aiInvocationObserverFailures()).toBe(before + 1);
    expect(events).toHaveLength(1);
  });

  test('adding the same observer twice registers it once; dispose removes it', async () => {
    const events: AIInvocationEvent[] = [];
    const fn = (e: AIInvocationEvent) => { events.push(e); };
    const d1 = observeAIInvocations(fn);
    observeAIInvocations(fn);
    await invokeAI(chat, async () => 1, () => null);
    expect(events).toHaveLength(1);
    d1();
    await invokeAI(chat, async () => 1, () => null);
    expect(events).toHaveLength(1);
  });

  test('attribution nests by merging and rides on observed events', async () => {
    const events = observe();
    await withAIAttribution({ request_id: 'r1', effect: 'facts-backstop' }, () =>
      withAIAttribution({ job_id: 7 }, async () => {
        expect(currentAIAttribution()).toEqual({ request_id: 'r1', effect: 'facts-backstop', job_id: 7 });
        await invokeAI(chat, async () => 1, () => null);
      }));
    expect(events[0]!.attribution).toEqual({ request_id: 'r1', effect: 'facts-backstop', job_id: 7 });
    expect(currentAIAttribution()).toBeNull();
  });
});
