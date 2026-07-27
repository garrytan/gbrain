/**
 * Vendor-neutral content guardrail seams.
 *
 * GBrain ingests content (markdown, code) into its retrieval layer and routes
 * queries/tool-inputs through an LLM gateway. A guardrail is an external
 * classifier — a content firewall, a PII scrubber, a prompt-injection detector —
 * that wants to *observe* the content flowing across those boundaries.
 *
 * This module exposes the seams without binding GBrain to any specific vendor.
 * Zero guardrails are registered by default; the OSS distribution ships inert.
 * Operators (or vendor plugins) register a {@link GuardrailProvider} via
 * {@link registerGuardrailProvider}, and the five hook points below await it
 * inline.
 *
 * ## Hard invariants (do not weaken these without an RFC)
 *
 * - **Observe-only.** `runGuardrails` returns `void`. Callers MUST NOT branch
 *   on any provider verdict. A guardrail cannot block, rewrite, drop, retry, or
 *   reorder GBrain behavior through this interface. Enforcement, if ever added,
 *   gets its own explicitly-named seam and its own RFC.
 * - **Fail open.** Missing config, provider throw, timeout, network error, and
 *   malformed responses are all swallowed. A broken guardrail never breaks an
 *   ingest, a query, or a tool call.
 * - **Inline await, no enqueue.** These hooks await the provider before
 *   proceeding so the classifier sees content at the exact pre-persist /
 *   pre-inference moment. Providers that want async fan-out own their own queue.
 * - **No verdict persistence.** GBrain does not write guardrail results to the
 *   DB. Providers own their own audit trail.
 * - **Content boundaries.** Hooks pass the user/ingest-facing payload only:
 *   the markdown/code body, the last user message, the expansion query, the
 *   tool input. They never pass system prompts, full chat history, tool
 *   OUTPUT, LLM output, embeddings, or multimodal/OCR/rerank payloads.
 *
 * @module guardrails
 */

/**
 * The boundary at which a guardrail is being consulted. Stable string union so
 * providers can route/score per-surface without parsing free text.
 */
export type GuardrailHook =
  /** Markdown/text body before chunking, embedding, and page persistence. */
  | 'file_storage.markdown'
  /** Code body before code-chunking, embedding, and page persistence. */
  | 'file_storage.code'
  /** Latest user message before LLM inference (chat). */
  | 'ai_gateway.chat'
  /** Search-expansion query before the expansion model call. */
  | 'ai_gateway.expand'
  /** Tool input before pending-persist and before tool execution. */
  | 'ai_gateway.tool_input';

/**
 * One guardrail invocation. `content` is the raw text the boundary handles;
 * `metadata` is provider-opaque, JSON-compatible context (slug, source kind,
 * tool name, model id, etc.). Neither field is mutated by GBrain.
 */
export interface GuardrailInput {
  hook: GuardrailHook;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * A registered guardrail backend. `classify` is awaited inline. Its return
 * value is intentionally `unknown` and intentionally ignored by GBrain — the
 * type exists only so providers can return a typed verdict to *their own*
 * logging/audit code. GBrain never reads it.
 */
export interface GuardrailProvider {
  /** Stable id for logs and dedupe (e.g. `"silmaril"`). */
  readonly id: string;
  classify(input: GuardrailInput): Promise<unknown> | unknown;
}

const providers = new Map<string, GuardrailProvider>();

/**
 * Register (or replace, by id) a guardrail provider. Idempotent per id so a
 * plugin re-init doesn't double-fire. No-op safe to call before any ingest.
 */
export function registerGuardrailProvider(provider: GuardrailProvider): void {
  if (!provider || typeof provider.classify !== 'function' || !provider.id) return;
  providers.set(provider.id, provider);
}

/** Remove a previously-registered provider. Returns true if one was removed. */
export function unregisterGuardrailProvider(id: string): boolean {
  return providers.delete(id);
}

/** Test/whole-reset helper. Clears all registered providers. */
export function __resetGuardrailProvidersForTests(): void {
  providers.clear();
}

/** Whether any guardrail is registered. Lets hot paths skip work cheaply. */
export function hasGuardrails(): boolean {
  return providers.size > 0;
}

/**
 * Consult every registered guardrail for this boundary. Returns `void` — the
 * result is never surfaced to the caller, by design (observe-only invariant).
 *
 * Fail-open: a provider that throws or rejects is isolated; its failure is
 * swallowed so the ingest/inference/tool path proceeds unchanged. Empty/blank
 * content short-circuits before any provider runs.
 *
 * Inline await: when guardrails are registered, the caller awaits this. The
 * cost is bounded by each provider's own timeout discipline; GBrain does not
 * impose one here so providers can tune per-deployment latency budgets.
 */
export async function runGuardrails(input: GuardrailInput): Promise<void> {
  if (providers.size === 0) return;
  const content = typeof input.content === 'string' ? input.content : '';
  if (!content.trim()) return;

  // Snapshot so a provider registering/unregistering mid-flight can't mutate
  // the iteration set.
  const snapshot = Array.from(providers.values());
  await Promise.all(
    snapshot.map(async (provider) => {
      try {
        await provider.classify({
          hook: input.hook,
          content,
          metadata: input.metadata,
        });
      } catch {
        // Fail open. A guardrail provider MUST NOT be able to break GBrain.
        // Provider-side logging is the provider's responsibility; GBrain does
        // not log raw content here (could itself leak the classified payload).
      }
    }),
  );
}
