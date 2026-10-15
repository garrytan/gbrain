/** Pure single-input classification shared by retry, healing and diagnostics.
 * Some local providers report permanent context overflow with a 5xx or no HTTP status.
 * Authentication, rate limits, transport failures and batch limits keep their existing handling. */
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

const OVER_LENGTH_STATUSES = new Set([400, 413, 422, 500, 502, 503, 504]);

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
  /input\s+is\s+too\s+large\s+to\s+process/i,
  /reduce\s+the\s+length\s+of\s+the\s+input/i,
  /input\s+must\s+be\s+less\s+than\s+\d+\s+tokens/i,
];

const BATCH_SHAPED = /\b(?:batch|per\s+request|overall|request\s+size)\b/i;

export function overLengthErrorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  let cur: unknown = e;
  const parts: string[] = [];
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { message?: unknown; cause?: unknown };
    if (typeof obj.message === 'string') parts.push(obj.message);
    cur = obj.cause;
  }
  return parts.join(' | ');
}

/**
 * True for a permanent request-shaped rejection whose message says ONE input
 * is too long. Batch-level token errors (messages about the batch / request as a whole) are not: shrinking
 * the batch, not the chunk, is their fix.
 */
export function isSingleInputOverLengthError(e: unknown): boolean {
  const status = statusFromCause(e);
  if (status !== undefined && !OVER_LENGTH_STATUSES.has(status)) return false;
  const msg = overLengthErrorMessage(e);
  if (/token.*limit.*exceeded/i.test(msg)) return false;
  if (BATCH_SHAPED.test(msg)) return false;
  return OVER_LENGTH_PATTERNS.some((re) => re.test(msg));
}

