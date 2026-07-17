/**
 * Retryable LLM-transport failure classifier for cycle phases.
 *
 * Used by propose_takes (and available to sibling phases) to decide whether a
 * per-item extractor/judge error should increment a consecutive-failure abort
 * budget. A dead egress path (proxy down, DNS blackhole, provider 5xx storm)
 * previously produced silent catch-and-continue success with zero work done.
 *
 * Classification rules (reviewer-locked):
 *   COUNT: timeout, abort-caused-by-deadline/timeout only, connection/DNS
 *          (ECONNREFUSED/ENOTFOUND/EAI_AGAIN/…), provider 5xx.
 *   DO NOT COUNT: bare AbortError (user cancel / unrelated signal), parse
 *          failures, content rejection, auth/config (4xx except that 5xx is
 *          counted above), empty results.
 *
 * Walk the error cause chain (Error.cause + AggregateError.errors + abort
 * reason). An SDK retry loop that exhausts and rethrows a wrapper whose only
 * timeout lives on `.cause` MUST still count — message-string regex alone is
 * insufficient. AbortError is retryable only when a timeout/deadline shape
 * appears on the message, cause, or reason.
 */

/** Consecutive retryable transport failures before the phase aborts as FAILED. */
export const CONSECUTIVE_TRANSPORT_FAILURE_BUDGET = 3;

const TRANSPORT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Non-retryable HTTP statuses (auth/config). 429 is rate-limit — not in the locked transport set. */
function isAuthOrConfigStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

function getStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return undefined;
}

function getCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function getName(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  if (typeof err === 'string') return err;
  return String(err ?? '');
}

/**
 * Does this single error node itself look like a retryable transport failure?
 * Cause-chain walking is handled by the public entry point.
 */
function nodeIsRetryableTransport(err: unknown): boolean {
  if (err == null) return false;

  const status = getStatus(err);
  if (typeof status === 'number') {
    if (status >= 500 && status < 600) return true;
    // Auth/config 4xx are explicitly non-transport — short-circuit this node.
    if (isAuthOrConfigStatus(status)) return false;
  }

  const code = getCode(err);
  if (code && TRANSPORT_CODES.has(code)) return true;

  const name = getName(err);
  // TimeoutError / ConnectTimeoutError always count. Bare AbortError does NOT —
  // only abort-caused-by-deadline/timeout counts (message patterns below, or a
  // timeout-shaped cause / AbortSignal.reason walked by the public entry).
  // User cancellation and unrelated signals must not burn the transport budget.
  if (name === 'TimeoutError' || name === 'ConnectTimeoutError') {
    return true;
  }

  const msg = getMessage(err);
  // Secondary signal only — the cause-chain walk is the primary footgun fix.
  if (
    /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (/\btimed?\s*out\b|timeout|deadline exceeded|aborted due to (timeout|deadline)/i.test(msg)) {
    return true;
  }
  if (/fetch failed|network error|socket hang up|connection refused|could not connect/i.test(msg)) {
    return true;
  }
  // Explicit non-transport shapes that message patterns might otherwise mis-fire on.
  if (/invalid api key|authentication|unauthorized|forbidden|json parse|content rejected|model not configured|safety filter/i.test(msg)) {
    return false;
  }

  return false;
}

/**
 * True when `err` (or any cause / AggregateError sub-error / abort reason) is a
 * retryable transport failure that should increment the consecutive-abort budget.
 */
export function isRetryableTransportFailure(err: unknown, seen: Set<unknown> = new Set()): boolean {
  if (err == null) return false;
  if (typeof err === 'object') {
    if (seen.has(err)) return false;
    seen.add(err);
  }

  if (nodeIsRetryableTransport(err)) return true;

  if (typeof err === 'object') {
    // Walk cause chain, AggregateError.errors, and AbortSignal/DOMException
    // abort reason (timeout deadline often lives only on `.reason`).
    const e = err as { cause?: unknown; errors?: unknown[]; reason?: unknown };
    if (e.cause != null && isRetryableTransportFailure(e.cause, seen)) return true;
    if (e.reason != null && isRetryableTransportFailure(e.reason, seen)) return true;
    if (Array.isArray(e.errors)) {
      for (const sub of e.errors) {
        if (isRetryableTransportFailure(sub, seen)) return true;
      }
    }
  }

  return false;
}
