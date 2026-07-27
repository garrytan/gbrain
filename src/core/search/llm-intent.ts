/**
 * v0.36 Commit 4 — opt-in LLM tie-break for ambiguous modality queries.
 *
 * The pure-regex classifier in query-intent.ts handles 99% of queries
 * cleanly. For the ambiguous middle band (`isAmbiguousModalityQuery`
 * returns true), the operator can opt into a Haiku tie-break via
 * `search.cross_modal.llm_intent: true`.
 *
 * Cost bound: <1% of queries when on; ~$0.0001 per escalation. Bypassed
 * entirely when the config flag is false (default).
 *
 * Fail-open: any error (timeout, parse failure, gateway misconfig) returns
 * the input fallback ('text') so a misbehaving LLM can never break search.
 */

import type { ModalityMode } from './query-intent.ts';

/** Default model tier for the tie-break call. Haiku 4.5 via utility tier. */
const TIE_BREAK_TIMEOUT_MS = 1000;

const SYSTEM_PROMPT =
  'You classify search query modality. Output exactly one word: text, image, or both.\n' +
  '- text: the user wants written content (notes, takes, bios, articles)\n' +
  '- image: the user wants visual content (photos, screenshots, diagrams)\n' +
  '- both: the user is asking something that could be either\n' +
  'Output nothing except one of: text image both';

/**
 * Run a Haiku tie-break to classify the modality of an ambiguous query.
 *
 * Returns `fallback` on any error (timeout, parse failure, unrecognized
 * output). Production callers gate this on the
 * `search.cross_modal.llm_intent` config flag AND
 * `isAmbiguousModalityQuery(query) === true` so the LLM call only fires
 * for the narrow band where it actually adds signal.
 */
export async function classifyModalityWithLLM(
  query: string,
  fallback: ModalityMode = 'text',
): Promise<ModalityMode> {
  let chat: typeof import('../ai/gateway.ts').chat;
  let isAvailable: typeof import('../ai/gateway.ts').isAvailable;
  try {
    ({ chat, isAvailable } = await import('../ai/gateway.ts'));
  } catch {
    return fallback;
  }
  if (!isAvailable('chat')) {
    // Quiet bail — caller decides whether to warn.
    return fallback;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIE_BREAK_TIMEOUT_MS);
  try {
    const result = await chat({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: query.slice(0, 500) }],
      maxTokens: 16,
      abortSignal: controller.signal,
    });
    return parseModality(result.text, fallback);
  } catch {
    // Timeout, network error, AI SDK throw — fail-open.
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the LLM's single-word output to a ModalityMode. Tolerates
 * trailing punctuation + casing. Anything unrecognized → fallback.
 */
export function parseModality(raw: string, fallback: ModalityMode): ModalityMode {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z]+/g, '');
  if (normalized === 'text' || normalized === 'image' || normalized === 'both') {
    return normalized;
  }
  return fallback;
}
