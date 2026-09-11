import { AsyncLocalStorage } from 'node:async_hooks';

export interface AIInvocation {
  operation: string;
  model: string;
  kind: 'chat' | 'embedding' | 'rerank' | 'multimodal';
  maxInputTokens?: number;
  maxOutputTokens?: number;
  cacheWriteTtl?: '5m' | '1h';
}
export interface AIInvocationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
export interface AIInvocationPermit { settle(usage: AIInvocationUsage | null): Promise<void> }
export type AIInvocationGuard = (call: AIInvocation) => Promise<AIInvocationPermit>;
const guards = new AsyncLocalStorage<AIInvocationGuard>();
const refused = new WeakSet<object>();

/** Preserve admission refusals through provider fallback/error normalization. */
export function isAIInvocationPolicyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && refused.has(error);
}

/** Isolated to this async job; concurrent local work never inherits its owner. */
export function withAIInvocationGuard<T>(guard: AIInvocationGuard, run: () => Promise<T>): Promise<T> {
  return guards.run(guard, run);
}
export function hasAIInvocationGuard(): boolean { return guards.getStore() !== undefined; }

/** One provider attempt. No guessed usage, no release on an ambiguous failure. */
export async function invokeAI<T>(call: AIInvocation, run: () => Promise<T>, usage: (result: T) => AIInvocationUsage | null | Promise<AIInvocationUsage | null>): Promise<T> {
  const guard = guards.getStore();
  if (!guard) return run();
  let permit: AIInvocationPermit;
  try { permit = await guard(call); }
  catch (error) {
    if (typeof error === 'object' && error !== null) refused.add(error);
    throw error;
  }
  let result: T;
  try { result = await run(); }
  catch (error) { await permit.settle(null); throw error; }
  let measured: AIInvocationUsage | null;
  try { measured = await usage(result); }
  catch (error) { await permit.settle(null); throw error; }
  await permit.settle(measured);
  return result;
}

export function sdkInvocationUsage(result: unknown): AIInvocationUsage | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, any>;
  const u = r.usage;
  if (!u || typeof u !== 'object') return null;
  const reportedInput = u.inputTokens ?? u.input_tokens ?? u.prompt_tokens ?? u.tokens ?? u.total_tokens;
  const output = u.outputTokens ?? u.output_tokens ?? u.completion_tokens ?? (u.tokens !== undefined || u.total_tokens !== undefined ? 0 : undefined);
  if (!Number.isFinite(reportedInput) || reportedInput < 0 || !Number.isFinite(output) || output < 0) return null;
  const cache = r.providerMetadata?.anthropic ?? {};
  const read = u.inputTokenDetails?.cacheReadTokens ?? cache.cacheReadInputTokens ?? cache.cache_read_input_tokens
    ?? u.cache_read_tokens ?? u.cache_read_input_tokens ?? u.cachedInputTokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const write = u.inputTokenDetails?.cacheWriteTokens ?? cache.cacheCreationInputTokens ?? cache.cache_creation_input_tokens
    ?? u.cache_creation_tokens ?? u.cache_creation_input_tokens ?? 0;
  // AI SDK/OpenAI report total input including cached tokens. Anthropic's
  // Messages API reports uncached input separately from cache reads/writes.
  const input = u.inputTokenDetails?.noCacheTokens
    ?? (u.inputTokens !== undefined || u.prompt_tokens !== undefined ? reportedInput - read - write : reportedInput);
  if ([input, read, write].some(n => !Number.isFinite(n) || n < 0)) return null;
  return { inputTokens: input, outputTokens: output,
    cacheReadTokens: read, cacheWriteTokens: write };
}

export async function responseInvocationUsage(response: Response): Promise<AIInvocationUsage | null> {
  try { return sdkInvocationUsage(await response.clone().json()); } catch { return null; }
}
