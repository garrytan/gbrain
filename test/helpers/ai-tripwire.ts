/**
 * Records every model call and every outbound network request a test makes.
 *
 * The invocation observer is the proof: every provider call routes through
 * `invokeAI` (scripts/check-ai-sdk-importers.sh keeps it that way), including
 * subprocess providers. The fetch wrapper is a second net for anything that
 * bypasses it; it records the request and then fails it, so nothing leaves the
 * machine. Tests assert on the records, never on a thrown error, because
 * best-effort catch blocks on write paths would swallow the throw.
 */
import { observeAIInvocations, type AIInvocationEvent } from '../../src/core/ai/invocation-guard.ts';

export const EMBEDDING_KINDS = new Set(['embedding', 'multimodal']);

export interface Tripwire {
  events: AIInvocationEvent[];
  egress: string[];
  /** Model calls that are not embeddings (chat, generate, rerank, decide, transcription). */
  generative(): AIInvocationEvent[];
  reset(): void;
  dispose(): void;
}

export function installTripwire(opts: { allowHosts?: string[] } = {}): Tripwire {
  const events: AIInvocationEvent[] = [];
  const egress: string[] = [];
  const disposeObserver = observeAIInvocations(event => { events.push(event); });
  const originalFetch = globalThis.fetch;
  const allow = new Set(opts.allowHosts ?? []);
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let host = '';
    try { host = new URL(url).host; } catch { host = url; }
    if (allow.has(host)) return originalFetch(input as never, init);
    egress.push(url);
    throw new Error(`tripwire: outbound request to ${url} blocked in a hermetic test`);
  }) as typeof fetch;
  globalThis.fetch = wrapped;
  return {
    events,
    egress,
    generative: () => events.filter(e => !EMBEDDING_KINDS.has(e.call.kind)),
    reset() { events.length = 0; egress.length = 0; },
    dispose() {
      disposeObserver();
      if (globalThis.fetch === wrapped) globalThis.fetch = originalFetch;
    },
  };
}
