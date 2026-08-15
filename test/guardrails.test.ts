/**
 * Vendor-neutral guardrail seam tests.
 *
 * Covers the contract every hook caller relies on:
 *   - observe-only (runGuardrails resolves void; never surfaces a verdict)
 *   - fail-open (provider throw/reject is swallowed)
 *   - inline await (provider is awaited before runGuardrails resolves)
 *   - inert by default (zero providers -> no-op, no provider calls)
 *   - empty/blank content short-circuits before any provider runs
 *   - register/unregister/reset semantics, idempotent by id
 *   - content + metadata are passed through unmutated
 *
 * Pure in-memory; no DB, no network.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  registerGuardrailProvider,
  unregisterGuardrailProvider,
  __resetGuardrailProvidersForTests,
  hasGuardrails,
  runGuardrails,
  type GuardrailInput,
  type GuardrailProvider,
} from '../src/core/guardrails.ts';

function recordingProvider(id: string, calls: GuardrailInput[]): GuardrailProvider {
  return {
    id,
    classify(input) {
      calls.push(input);
    },
  };
}

describe('guardrails — inert by default', () => {
  beforeEach(() => __resetGuardrailProvidersForTests());

  test('no providers registered -> hasGuardrails() is false', () => {
    expect(hasGuardrails()).toBe(false);
  });

  test('runGuardrails with no providers resolves void and does nothing', async () => {
    const result = await runGuardrails({ hook: 'file_storage.markdown', content: 'hello' });
    expect(result).toBeUndefined();
  });
});

describe('guardrails — registration semantics', () => {
  beforeEach(() => __resetGuardrailProvidersForTests());

  test('register flips hasGuardrails() true; unregister flips it back', () => {
    const calls: GuardrailInput[] = [];
    registerGuardrailProvider(recordingProvider('p1', calls));
    expect(hasGuardrails()).toBe(true);
    expect(unregisterGuardrailProvider('p1')).toBe(true);
    expect(hasGuardrails()).toBe(false);
  });

  test('registering same id twice does not double-fire', async () => {
    const calls: GuardrailInput[] = [];
    registerGuardrailProvider(recordingProvider('dup', calls));
    registerGuardrailProvider(recordingProvider('dup', calls));
    await runGuardrails({ hook: 'ai_gateway.chat', content: 'x' });
    expect(calls.length).toBe(1);
  });

  test('malformed provider (no classify) is rejected silently', () => {
    // @ts-expect-error intentionally malformed
    registerGuardrailProvider({ id: 'bad' });
    expect(hasGuardrails()).toBe(false);
  });

  test('provider without id is rejected', () => {
    registerGuardrailProvider({ id: '', classify: () => {} });
    expect(hasGuardrails()).toBe(false);
  });
});

describe('guardrails — observe-only + fail-open', () => {
  beforeEach(() => __resetGuardrailProvidersForTests());

  test('a throwing provider never breaks runGuardrails (fail-open)', async () => {
    registerGuardrailProvider({
      id: 'boom',
      classify() {
        throw new Error('classifier exploded');
      },
    });
    // Must resolve, not reject.
    await expect(runGuardrails({ hook: 'file_storage.code', content: 'code' })).resolves.toBeUndefined();
  });

  test('a rejecting async provider never breaks runGuardrails', async () => {
    registerGuardrailProvider({
      id: 'reject',
      async classify() {
        throw new Error('async boom');
      },
    });
    await expect(runGuardrails({ hook: 'ai_gateway.expand', content: 'q' })).resolves.toBeUndefined();
  });

  test('one bad provider does not stop a good provider (isolation)', async () => {
    const calls: GuardrailInput[] = [];
    registerGuardrailProvider({ id: 'bad', classify() { throw new Error('x'); } });
    registerGuardrailProvider(recordingProvider('good', calls));
    await runGuardrails({ hook: 'ai_gateway.tool_input', content: 'tool' });
    expect(calls.length).toBe(1);
    expect(calls[0]!.hook).toBe('ai_gateway.tool_input');
  });

  test('verdict returned by provider is ignored (no surface)', async () => {
    registerGuardrailProvider({
      id: 'verdict',
      classify: () => ({ blocked: true, score: 0.99, prediction: 'MALICIOUS' }),
    });
    const result = await runGuardrails({ hook: 'file_storage.markdown', content: 'poison' });
    // runGuardrails is void regardless of what the provider returns.
    expect(result).toBeUndefined();
  });
});

describe('guardrails — inline await', () => {
  beforeEach(() => __resetGuardrailProvidersForTests());

  test('runGuardrails awaits a slow async provider before resolving', async () => {
    let settled = false;
    registerGuardrailProvider({
      id: 'slow',
      async classify() {
        await new Promise((r) => setTimeout(r, 25));
        settled = true;
      },
    });
    await runGuardrails({ hook: 'ai_gateway.chat', content: 'hi' });
    // If runGuardrails returned before awaiting, settled would still be false.
    expect(settled).toBe(true);
  });
});

describe('guardrails — content guards', () => {
  beforeEach(() => __resetGuardrailProvidersForTests());

  test('empty content short-circuits before provider runs', async () => {
    const calls: GuardrailInput[] = [];
    registerGuardrailProvider(recordingProvider('p', calls));
    await runGuardrails({ hook: 'file_storage.markdown', content: '' });
    expect(calls.length).toBe(0);
  });

  test('whitespace-only content short-circuits', async () => {
    const calls: GuardrailInput[] = [];
    registerGuardrailProvider(recordingProvider('p', calls));
    await runGuardrails({ hook: 'file_storage.markdown', content: '   \n\t ' });
    expect(calls.length).toBe(0);
  });

  test('content and metadata pass through unmutated', async () => {
    const calls: GuardrailInput[] = [];
    registerGuardrailProvider(recordingProvider('p', calls));
    const meta = { slug: 'people/jane', source_kind: 'webpage', nested: { a: 1 } };
    await runGuardrails({ hook: 'file_storage.markdown', content: 'body text', metadata: meta });
    expect(calls.length).toBe(1);
    expect(calls[0]!.content).toBe('body text');
    expect(calls[0]!.metadata).toEqual(meta);
  });
});
