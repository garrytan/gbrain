/**
 * Single-input over-length classification, shared by the embed retry loop
 * (`embed-retry.ts`), the per-chunk fan-out (`embedPageTexts`) and the heal
 * (`embed-overlength-heal.ts`). Pure; imports nothing that imports the retry
 * loop.
 *
 * A 400/413/422 counts when its message has one of the over-length shapes. A
 * 5xx or statusless error (#6772: llama.cpp's server answers 500 "input (N
 * tokens) is larger than the max context size", Ollama 500 "input length
 * exceeds the context length") counts only on explicit token or
 * context-length wording, because 5xx bodies such as "The input queue is too
 * long" or "exceeds maximum concurrent connection limit" are transient.
 * Batch-level token errors (the gateway's `isTokenLimitError`, or any message
 * about the batch or request as a whole) never count: shrinking the batch,
 * not the chunk, is their fix.
 */

import { isTokenLimitError } from './ai/gateway.ts';

/** Walk the cause chain (like detect429FromCause) for the first HTTP status. */
export function statusFromCause(e: unknown): number | undefined {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    cur = obj.cause;
  }
  return undefined;
}

const OVER_LENGTH_STATUSES = new Set([400, 413, 422]);

const OVER_LENGTH_PATTERNS: readonly RegExp[] = [
  // NVIDIA NIM: "Input length 1460 exceeds maximum allowed token size 512"
  /exceeds?\s+(?:the\s+)?max(?:imum)?[^.\n]{0,40}(?:token|context|length|limit)/i,
  // llama.cpp / Ollama: "input length exceeds the context length"
  /(?:input|prompt|text|sequence)[^.\n]{0,30}exceeds?[^.\n]{0,30}(?:context|length|limit)/i,
  // OpenAI-compatible: "This model's maximum context length is 8192 tokens, however you requested …"
  /max(?:imum)?\s+context\s+length\s+is\s+\d+/i,
  // DashScope: "Range of input length should be [1, 2048]"
  /range\s+of\s+input\s+length/i,
  // Generic: "input text is too long", "text too long for this model"
  /(?:input|prompt|text|sequence)[^.\n]{0,30}too\s+long/i,
];

/** #6772: the subset that names a token or context limit, the only wording trusted behind a 5xx or no status. */
const EXPLICIT_OVER_LENGTH_PATTERNS: readonly RegExp[] = [
  // llama.cpp server: "input (1234 tokens) is larger than the max context size (512 tokens)"
  /larger\s+than\s+the\s+max(?:imum)?\s+context\s+size/i,
  /max(?:imum)?\s+context\s+length\s+is\s+\d+/i,
  // Ollama "input length exceeds the context length"; NIM "exceeds maximum allowed token size 512"
  /exceeds?\s+(?:the\s+)?(?:model'?s\s+)?(?:max(?:imum)?\s+)?(?:allowed\s+)?(?:input\s+)?(?:context\s+(?:length|size|window)|token\s+(?:size|limit|count))/i,
  // "the input of 9000 tokens exceeds the maximum of 8192"
  /\b\d+\s+tokens?\b[^.\n]{0,60}\b(?:exceeds?|larger\s+than|greater\s+than|more\s+than)\b[^.\n]{0,40}\b(?:max(?:imum)?|limit|context)\b/i,
];

const BATCH_SHAPED = /\b(?:batch|per\s+request|overall|request\s+size)\b/i;

/** Every message on the cause chain, joined. */
export function overLengthMessage(e: unknown): string {
  let cur: unknown = e;
  const parts: string[] = [];
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { message?: unknown; cause?: unknown };
    if (typeof obj.message === 'string') parts.push(obj.message);
    cur = obj.cause;
  }
  return parts.join(' | ');
}

/** True for a rejection whose message says ONE input is over the model's limit. */
export function isSingleInputOverLengthError(e: unknown): boolean {
  const status = statusFromCause(e);
  const requestShaped = status !== undefined && OVER_LENGTH_STATUSES.has(status);
  if (!requestShaped && status !== undefined && status < 500) return false;
  if (isTokenLimitError(e)) return false;
  const msg = overLengthMessage(e);
  if (BATCH_SHAPED.test(msg)) return false;
  return (requestShaped ? OVER_LENGTH_PATTERNS : EXPLICIT_OVER_LENGTH_PATTERNS).some((re) => re.test(msg));
}
