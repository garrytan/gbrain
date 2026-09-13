import { invokeAI, sdkInvocationUsage, hasAIInvocationGuard, type AIInvocation } from './invocation-guard.ts';
import { resolveChatContextTokens } from './model-resolver.ts';

export function chatInvocation(operation: string, model: string, maxOutputTokens: number): AIInvocation {
  let maxInputTokens: number | undefined;
  try { maxInputTokens = resolveChatContextTokens(model); } catch { /* finite admission refuses an unknown maximum */ }
  return { operation, kind: 'chat', model, maxInputTokens, maxOutputTokens };
}

/** Each SDK attempt has its own durable hold; local calls keep SDK retries. */
export function createGuardedGeneration(defaultMaxOutputTokens: () => number) {
  return async function guardedGeneration<T>(model: string, transport: (opts: any) => Promise<T>, opts: any): Promise<T> {
    if (!hasAIInvocationGuard()) return transport(opts);
    const maxOutputTokens = opts.maxOutputTokens ?? defaultMaxOutputTokens();
    return invokeAI({ ...chatInvocation('gateway.generate', model, maxOutputTokens),
      cacheWriteTtl: opts.providerOptions?.anthropic?.cacheControl?.ttl ?? '5m' },
      () => transport({ ...opts, maxOutputTokens, maxRetries: 0 }), sdkInvocationUsage);
  };
}
