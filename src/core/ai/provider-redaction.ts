/**
 * Provider egress redaction — the gateway half of the redaction seam
 * (`redaction-policy.ts`). When `redaction.egress_classes` names any class,
 * every piece of provider-bound text (embedding inputs, rerank query and
 * documents, the expansion query, chat system prompt, messages, tool inputs
 * and tool results) is run through the canonical scanner and each claimed
 * span becomes its `<REDACTED:pattern>` token before the request leaves.
 * Default off: with no classes every helper returns its input untouched.
 *
 * Order at every gateway call site is fixed: guardrail observe (raw) ->
 * redact -> send. The observe-only providers of `guardrails.ts` keep seeing
 * the pre-redaction text.
 *
 * Counts, not content: every redaction increments a per-surface, per-pattern
 * counter and notifies observers with `{ surface, pattern, count }`. No value
 * and no text is ever recorded here.
 *
 * Fail-closed: the scanner is deterministic and bounded (perf-pinned); a
 * throw here is a bug and surfaces as the call's error. It is deliberately
 * not swallowed — silently sending raw text is the outcome this seam exists
 * to prevent. (`guardrails.ts` fails open; this module is the other arm.)
 */
import { applyRedaction, planRedaction, type SecretFinding } from '../secret-scan.ts';
import { redactionPolicy } from '../redaction-policy.ts';

export type ProviderSurface = 'embed' | 'rerank' | 'expand' | 'chat' | 'chat_system' | 'tool_input' | 'tool_result';

export interface ProviderRedactionEvent {
  surface: ProviderSurface;
  pattern: string;
  count: number;
}

/** Structural view of a gateway `ChatMessage` (the gateway imports this module, so no type import back). */
interface MessageLike {
  role: string;
  content: string | Array<Record<string, unknown> & { type: string }>;
}

const counts = new Map<string, number>();
const observers = new Set<(event: ProviderRedactionEvent) => void>();

function record(surface: ProviderSurface, redactions: SecretFinding[]): void {
  const perPattern = new Map<string, number>();
  for (const r of redactions) perPattern.set(r.pattern, (perPattern.get(r.pattern) ?? 0) + 1);
  for (const [pattern, count] of perPattern) {
    const key = `${surface}\t${pattern}`;
    counts.set(key, (counts.get(key) ?? 0) + count);
    for (const observer of observers) {
      try { observer({ surface, pattern, count }); } catch { /* an observer never breaks a provider call */ }
    }
  }
}

/** Redactions applied in this process since start (or the last test reset), per surface and pattern. */
export function providerRedactionCounts(): ProviderRedactionEvent[] {
  return [...counts.entries()].map(([key, count]) => {
    const [surface, pattern] = key.split('\t') as [ProviderSurface, string];
    return { surface, pattern, count };
  });
}

/** Register an observer of every provider-bound redaction. Returns its disposer. */
export function observeProviderRedactions(observer: (event: ProviderRedactionEvent) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

export function __resetProviderRedactionsForTests(): void {
  counts.clear();
  observers.clear();
}

/** Redact one provider-bound string under the egress policy; non-strings and empty strings pass through. */
export function redactProviderText<T extends string | undefined | null>(text: T, surface: ProviderSurface): T {
  if (typeof text !== 'string' || text.length === 0) return text;
  const classes = redactionPolicy().egress;
  if (classes.length === 0) return text;
  const plan = planRedaction(text, { classes, highEntropy: classes.includes('credential') });
  if (plan.claimed.length === 0) return text;
  record(surface, plan.redactions);
  return applyRedaction(plan) as T;
}

/** Redact a batch (embedding inputs, rerank documents). Returns the same array when the policy is off. */
export function redactProviderTexts(texts: string[], surface: ProviderSurface): string[] {
  if (redactionPolicy().egress.length === 0) return texts;
  return texts.map((t) => redactProviderText(t, surface));
}

/** A JSON value (tool input / output) redacted through its serialized form; returned as-is when nothing was claimed. */
function redactJsonValue(value: unknown, surface: ProviderSurface): unknown {
  if (typeof value === 'string') return redactProviderText(value, surface);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return value; }
  const redacted = redactProviderText(serialized, surface);
  if (redacted === serialized) return value;
  try { return JSON.parse(redacted); } catch { return redacted; }
}

/**
 * Redact every text-bearing part of a chat conversation: string contents,
 * text and reasoning blocks, tool-call inputs and tool-result outputs. Returns
 * the same array when the policy is off, and never mutates the caller's
 * messages.
 */
export function redactProviderMessages<M extends MessageLike>(messages: M[]): M[] {
  if (redactionPolicy().egress.length === 0) return messages;
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      const content = redactProviderText(m.content, 'chat');
      return content === m.content ? m : { ...m, content };
    }
    let changed = false;
    const blocks = m.content.map((b) => {
      if ((b.type === 'text' || b.type === 'reasoning') && typeof b.text === 'string') {
        const text = redactProviderText(b.text, 'chat');
        if (text === b.text) return b;
        changed = true; return { ...b, text };
      }
      if (b.type === 'tool-call' && 'input' in b) {
        const input = redactJsonValue(b.input, 'tool_input');
        if (input === b.input) return b;
        changed = true; return { ...b, input };
      }
      if (b.type === 'tool-result' && 'output' in b) {
        const output = redactJsonValue(b.output, 'tool_result');
        if (output === b.output) return b;
        changed = true; return { ...b, output };
      }
      return b;
    });
    return changed ? { ...m, content: blocks } : m;
  });
}
