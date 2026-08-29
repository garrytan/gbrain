/**
 * AI service error hierarchy. Three classes mapping to caller decisions:
 *
 *   AIConfigError     — user fixes: bad key, missing model, dim mismatch.
 *                       Abort + show recovery recipe.
 *   AITransientError  — retryable: SDK retries exhausted, rate limit sustained.
 *                       Propagate so job queue can retry later.
 *   AIServiceError    — base class for both.
 *
 * The `fix` field carries a human-readable recovery recipe agents and humans
 * can act on. The `cause` field preserves the underlying SDK error.
 */

export class AIServiceError extends Error {
  /**
   * HTTP status of the underlying API failure, carried through top-level by
   * `normalizeAIError` when the wrapped error exposes one (e.g. the claude-cli
   * provider's ClaudeCliProcessError.apiErrorStatus), so callers can branch on
   * it without digging into `cause`.
   */
  apiErrorStatus?: number;
  /** HTTP status carried through from a wrapped error's own `status` field. */
  status?: number;

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AIServiceError';
  }
}

export class AIConfigError extends AIServiceError {
  constructor(
    message: string,
    public readonly fix?: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'AIConfigError';
  }
}

export class AITransientError extends AIServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AITransientError';
  }
}

/**
 * Normalize any thrown error into our hierarchy. AI SDK errors are inspected
 * by status code + name; unknown errors default to AITransientError so the
 * caller does not permanently abort on a transient network blip.
 */
/**
 * Copy status fields from the wrapped error onto the normalized error's top
 * level (same property names), so typed information like the claude-cli
 * provider's `apiErrorStatus` stays reachable without unwrapping `cause`.
 */
function carryStatusFields(from: unknown, to: AIServiceError): AIServiceError {
  const src = from as { apiErrorStatus?: unknown; status?: unknown } | null | undefined;
  if (src && typeof src === 'object') {
    if (typeof src.apiErrorStatus === 'number') to.apiErrorStatus = src.apiErrorStatus;
    if (typeof src.status === 'number') to.status = src.status;
  }
  return to;
}

export function normalizeAIError(err: unknown, context?: string): AIServiceError {
  if (err instanceof AIServiceError) return err;

  const anyErr = err as {
    name?: string;
    status?: number;
    statusCode?: number;
    apiErrorStatus?: unknown;
    message?: string;
  };
  // apiErrorStatus is the claude-cli provider's typed HTTP status
  // (ClaudeCliProcessError); without it a claude-cli 401/403 fell through to
  // AITransientError and got retried forever instead of surfacing as a
  // config-level failure like every other provider's 4xx.
  const status =
    anyErr?.status ??
    anyErr?.statusCode ??
    (typeof anyErr?.apiErrorStatus === 'number' ? anyErr.apiErrorStatus : undefined);
  const name = anyErr?.name ?? '';
  const msg = anyErr?.message ?? String(err);
  const ctxPrefix = context ? `[${context}] ` : '';

  // 4xx (except 429) = config-level, non-retryable
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return carryStatusFields(err, new AIConfigError(
      `${ctxPrefix}${msg}`,
      status === 401 || status === 403
        ? 'Check your API key is valid and has access to this model.'
        : 'Check your model id + provider options match the provider API.',
      err,
    ));
  }

  // AI SDK named errors
  if (name === 'LoadAPIKeyError' || name === 'InvalidArgumentError') {
    return carryStatusFields(err, new AIConfigError(`${ctxPrefix}${msg}`, undefined, err));
  }

  // Everything else (5xx, timeouts, network) = transient
  return carryStatusFields(err, new AITransientError(`${ctxPrefix}${msg}`, err));
}

/** Whole-run LLM failure classes — see classifyGlobalLlmError. */
export type GlobalLlmErrorClass = 'auth' | 'billing' | 'rate_limit';

/**
 * Consecutive rate_limit-classified failures a cycle phase tolerates before
 * halting. auth/billing halt on the FIRST hit — a revoked key or an exhausted
 * spend limit is deterministic — but a bare 429 can be a transient burst that
 * clears between calls, so phases only abort after this many in a row (the
 * same intuition as the #2894 transport streak, applied at this layer's
 * consumers). A successful LLM call resets the streak.
 */
export const RATE_LIMIT_HALT_STREAK = 3;

/**
 * Request-shaped 4xx statuses that stay PER-ITEM even when wrapped in
 * AIConfigError by normalizeAIError: context length (400), request timeout
 * (408), payload too large (413), validation (422) can genuinely differ from
 * one page/take to the next, so they never justify a whole-run halt.
 */
const PER_ITEM_HTTP_STATUSES = new Set([400, 408, 413, 422]);

// Billing phrases are deliberately TIGHTER than sync-failure-ledger's
// EMBEDDING_QUOTA regex (which matches bare /billing/): a global-error hit
// halts an entire cycle phase, so a stray word inside a raw-output slice
// must not trip it. Only specific provider phrasings qualify.
const BILLING_MESSAGE_RE =
  /insufficient_quota|quota exceeded|exceeded your (?:current )?quota|credit balance is too low|spend limit|billing_not_active|billing hard limit|payment required/i;
const AUTH_MESSAGE_RE =
  /authentication_error|permission_error|invalid (?:x-)?api[-_ ]?key|api key (?:is )?(?:invalid|expired|missing)|unauthorized/i;
const RATE_MESSAGE_RE = /rate[-_ ]?limit(?:ed|_error)?\b|too many requests/i;
// Structured status forms only; a bare number in prose ("processed 429
// pages") never matches either shape. The quoted-JSON form
// (`"api_error_status":429`, the claude-cli result blob) cannot occur as free
// prose, so it may scan the FULL message including any raw-output slice. The
// prose-shaped forms (`HTTP 429`, `status 429`, `status code: 401`) CAN occur
// inside model/page-derived text, so they only ever scan the pre-raw slice.
const STRUCTURED_JSON_STATUS_RE =
  /"(?:api_error_status|status|statusCode)"\s*:\s*(401|402|403|429)\b/i;
const STRUCTURED_PROSE_STATUS_RE =
  /(?:\bHTTP[ /]|\bstatus(?:\s+code)?\s*[:= ]\s*)(401|402|403|429)\b/i;

function numericStatusOf(e: unknown): number | undefined {
  const anyErr = e as Record<string, unknown> | null | undefined;
  for (const key of ['status', 'statusCode', 'apiErrorStatus', 'api_error_status']) {
    const v = anyErr?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function statusToClass(status: number): GlobalLlmErrorClass | null {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  return null;
}

/**
 * Detect whole-run LLM failure conditions — auth, billing, rate limit — that
 * make retrying the SAME call on the next item pointless: every remaining
 * page/take in a cycle phase would fail identically (#3044). Callers halt
 * their per-item loop on 'auth'/'billing' immediately and on 'rate_limit'
 * after RATE_LIMIT_HALT_STREAK consecutive hits, surfacing a phase-level
 * halt instead of accumulating one swallowed warning per item.
 *
 * Matching is conservative by design: numeric status properties on the error
 * (or its `cause` chain), STRUCTURED status forms in the message, or specific
 * provider phrases. Plain 400s (context length, malformed request) stay
 * per-item — they can genuinely differ page to page. Billing phrases outrank
 * a 429 status because a monthly spend limit surfaces as 429 but is a billing
 * condition, not a transient rate limit.
 */
export function classifyGlobalLlmError(err: unknown): GlobalLlmErrorClass | null {
  const messages: string[] = [];
  let status: number | undefined;
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur != null; depth++) {
    if (status === undefined) status = numericStatusOf(cur);
    if (typeof cur === 'string') messages.push(cur);
    else if (typeof (cur as { message?: unknown }).message === 'string') {
      messages.push((cur as { message: string }).message);
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  const message = messages.join('\n');
  // Phrase regexes (and the prose-shaped status forms) only see text BEFORE
  // any raw-output slice: adapter errors append model output after a
  // `--- raw ---` marker (see claude-cli-language-model.ts), and free prose
  // in that slice ("the provider rate limit should increase", "Request
  // failed: HTTP 429") must not trip a whole-run halt. Only the quoted
  // `"api_error_status":NNN` JSON form stays safe on the FULL text — that key
  // cannot occur as free prose, and the claude-cli error blob it targets can
  // land on either side of the marker.
  const rawIdx = message.indexOf('--- raw ---');
  const phraseText = rawIdx === -1 ? message : message.slice(0, rawIdx);

  if (BILLING_MESSAGE_RE.test(phraseText)) return 'billing';
  if (status !== undefined) {
    const byStatus = statusToClass(status);
    if (byStatus) return byStatus;
  }
  // Config-level errors are whole-run by construction — a missing/invalid
  // key or an unknown model id fails identically on every call. The gateway
  // throws AIConfigError directly for missing keys ("OpenAI chat requires
  // OPENAI_API_KEY.") with NO status and NO phrase the regexes below could
  // safely match, so classify structurally. Exception: normalizeAIError
  // wraps ALL non-429 4xx as AIConfigError, and the request-shaped ones
  // (PER_ITEM_HTTP_STATUSES) are genuinely per-item — they fall through.
  if (err instanceof AIConfigError && !(status !== undefined && PER_ITEM_HTTP_STATUSES.has(status))) {
    return 'auth';
  }
  const structured =
    STRUCTURED_JSON_STATUS_RE.exec(message) ?? STRUCTURED_PROSE_STATUS_RE.exec(phraseText);
  if (structured) {
    const byMessageStatus = statusToClass(Number(structured[1]));
    if (byMessageStatus) return byMessageStatus;
  }
  if (AUTH_MESSAGE_RE.test(phraseText)) return 'auth';
  if (RATE_MESSAGE_RE.test(phraseText)) return 'rate_limit';
  return null;
}

/** Per-error verdict from GlobalLlmHaltTracker.observe: halt the phase now, or keep going. */
export type GlobalLlmHaltDecision =
  | 'halt-auth'
  | 'halt-billing'
  | 'halt-rate_limit'
  | 'continue';

/** Map a halt decision back to its GlobalLlmErrorClass ('continue' → null). */
export function haltedClassOf(decision: GlobalLlmHaltDecision): GlobalLlmErrorClass | null {
  return decision === 'continue' ? null : (decision.slice('halt-'.length) as GlobalLlmErrorClass);
}

export interface GlobalLlmHaltTracker {
  /**
   * Classify one per-item LLM failure and fold it into the halt policy.
   * `countRateLimit: false` skips the streak increment (grade_takes counts a
   * rate-limited take at most once across its ensemble judges) but still
   * reports a halt when the streak already crossed the threshold.
   */
  observe(err: unknown, opts?: { countRateLimit?: boolean }): GlobalLlmHaltDecision;
  /** classifyGlobalLlmError result of the most recent observe() (null = not global). */
  lastClass(): GlobalLlmErrorClass | null;
  /** A successful LLM call breaks the consecutive rate-limit streak. */
  reset(): void;
  /** Abort-message fragment for the most recent halt decision (byte-stable — callers pin it). */
  note(): string;
}

/**
 * The one halt policy every cycle phase's per-item LLM loop applies (#3044):
 * auth/billing halt on the FIRST hit (a revoked key or exhausted spend limit
 * is deterministic — every remaining item would fail identically); a bare
 * rate_limit halts only after RATE_LIMIT_HALT_STREAK consecutive hits (a
 * burst 429 can clear between items); everything else stays per-item.
 * One tracker per phase run — the streak is phase-scoped state.
 */
export function createGlobalLlmHaltTracker(): GlobalLlmHaltTracker {
  let rateLimitStreak = 0;
  let lastCls: GlobalLlmErrorClass | null = null;
  let lastNote = '';
  return {
    observe(err, opts) {
      const cls = classifyGlobalLlmError(err);
      lastCls = cls;
      if (cls === 'auth' || cls === 'billing') {
        lastNote = `${cls} error is a whole-run condition`;
        return `halt-${cls}`;
      }
      if (cls === 'rate_limit') {
        if (opts?.countRateLimit !== false) rateLimitStreak += 1;
        if (rateLimitStreak >= RATE_LIMIT_HALT_STREAK) {
          lastNote = `${RATE_LIMIT_HALT_STREAK} consecutive rate_limit errors are a whole-run condition`;
          return 'halt-rate_limit';
        }
      }
      return 'continue';
    },
    lastClass: () => lastCls,
    reset() {
      rateLimitStreak = 0;
    },
    note: () => lastNote,
  };
}
