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
export function normalizeAIError(err: unknown, context?: string): AIServiceError {
  if (err instanceof AIServiceError) return err;

  const anyErr = err as { name?: string; status?: number; statusCode?: number; message?: string };
  const status = anyErr?.status ?? anyErr?.statusCode;
  const name = anyErr?.name ?? '';
  const msg = anyErr?.message ?? String(err);
  const ctxPrefix = context ? `[${context}] ` : '';

  // Providers commonly report an exhausted account/project spend cap as
  // HTTP 429. That is not a transient rate limit: retrying the same request
  // cannot succeed until billing or the cap changes. Classify it before the
  // generic 429 path so query search can fall back immediately.
  if (/\b(?:monthly\s+)?spend(?:ing)?\s+cap\b|\bbilling\s+(?:quota|limit)\b/i.test(msg)) {
    return new AIConfigError(
      `${ctxPrefix}${msg}`,
      'Increase the provider billing/spending cap or configure a different model.',
      err,
    );
  }

  // 4xx (except 429) = config-level, non-retryable
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return new AIConfigError(
      `${ctxPrefix}${msg}`,
      status === 401 || status === 403
        ? 'Check your API key is valid and has access to this model.'
        : 'Check your model id + provider options match the provider API.',
      err,
    );
  }

  // AI SDK named errors
  if (name === 'LoadAPIKeyError' || name === 'InvalidArgumentError') {
    return new AIConfigError(`${ctxPrefix}${msg}`, undefined, err);
  }

  // Everything else (5xx, timeouts, network) = transient
  return new AITransientError(`${ctxPrefix}${msg}`, err);
}
