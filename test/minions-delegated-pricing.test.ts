import { expect, test } from 'bun:test';
import { actualCents, maximumInvocationCents } from '../src/core/minions/delegated-spend.ts';
import type { AIInvocation } from '../src/core/ai/invocation-guard.ts';

const call = (c: Partial<AIInvocation> & Pick<AIInvocation, 'kind' | 'model'>) => ({ operation: 'test', ...c }) as AIInvocation;

test('#6546 a known-price embedding with no maxOutputTokens has a finite maximum', () => {
  expect(maximumInvocationCents(call({ kind: 'embedding', model: 'openai:text-embedding-3-small', maxInputTokens: 1_000_000 }))).toBeGreaterThan(0);
});

test('#6546 pricing.overrides prices chat and rerank routes the tables cannot', () => {
  const chat = call({ kind: 'chat', model: 'litellm:quality', maxInputTokens: 1000, maxOutputTokens: 1000 });
  const rerank = call({ kind: 'rerank', model: 'litellm:rerank-local', maxInputTokens: 1000 });
  expect(maximumInvocationCents(chat)).toBeNull();
  expect(maximumInvocationCents(rerank)).toBeNull();
  const overrides = { 'litellm:quality': { input: 0, output: 0 }, 'litellm:rerank-local': { input: 0, output: 0 } };
  expect(maximumInvocationCents(chat, overrides)).toBe(0);
  expect(maximumInvocationCents(rerank, overrides)).toBe(0);
  const paid = { 'litellm:quality': { input: 100, output: 100 } };
  expect(maximumInvocationCents(chat, paid)).toBe(30);
  expect(actualCents(chat, { inputTokens: 1000, outputTokens: 50 }, paid)).toBe(10.5);
});

test('#6546 an override row keeps the table cache-write semantics', () => {
  const overrides = { 'litellm:quality': { input: 1, output: 1, cache_read: 0.1, cache_write: 1.25 } };
  const chat = call({ kind: 'chat', model: 'litellm:quality', maxInputTokens: 1000, maxOutputTokens: 0, cacheWriteTtl: '1h' });
  expect(actualCents(chat, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 1000 }, overrides)).toBe(0.21);
  expect(actualCents({ ...chat, cacheWriteTtl: undefined }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 1000 }, overrides)).toBe(0.135);
});

test('#6546 an unpriced route stays unpriced', () => {
  expect(maximumInvocationCents(call({ kind: 'chat', model: 'example:unpriced-model', maxInputTokens: 10, maxOutputTokens: 10 }), {})).toBeNull();
});
