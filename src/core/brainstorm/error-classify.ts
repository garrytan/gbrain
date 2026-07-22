/**
 * v0.39.3.0 WARN-10 + CV11 + T4 — brainstorm timeout classifier.
 *
 * Pre-fix: brainstorm + lsd consistently produced no output on
 * PgBouncer transaction-mode environments when listPrefixSampledPages
 * or hybrid search exceeded the statement timeout. The error reached
 * runBrainstormCli as a generic Error and surfaced as the catch-all
 * 'gbrain: unknown error' fallback, silently consuming the user's
 * cost-preview wait and producing zero ideas.
 *
 * Fix: orchestrator wraps its entire body in one try/catch (covers
 * every 57014 source — prefix enumeration, hybrid search, domain bank
 * fetch, embedding fetch, save phase). On classifier-positive match,
 * throw `StructuredAgentError` with code='brainstorm_timeout' and a
 * hint covering all PG cancel sub-causes (statement timeout, lock
 * timeout, user cancel). Non-57014 errors rethrow as-is so unrelated
 * bug classes (OAuth, network, embedding-provider) keep their natural
 * shape.
 *
 * Per T4: match SQLSTATE 57014 specifically (the spec-defined
 * 'query_canceled' code). Per CV11 + codex F#19: hint phrasing reads
 * 'query canceled' (generic) rather than 'statement timeout' (one
 * sub-cause) so the message stays honest across all three PG cancel
 * sub-causes.
 *
 * Per T4 + codex F#20: covers ALL orchestrator-internal SQL sites by
 * being applied at the entry-point wrap, not at per-call wraps. Adding
 * a new SQL call inside the orchestrator is automatically covered.
 */

import { StructuredAgentError } from '../errors.ts';

/**
 * Detect Postgres SQLSTATE 57014 (query_canceled) on an unknown thrown
 * value. The error shape varies by driver — postgres.js attaches
 * `.code`, pg attaches `.code`, PGLite surfaces through `.code` or
 * exposes the SQLSTATE in the message. Cast generically to a record
 * type so we can probe both.
 */
export function isQueryCanceledError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  // postgres.js + pg both attach the SQLSTATE on .code as a string.
  if (e.code === '57014') return true;
  // PGLite exposes via .code or surfaces in .message.
  if (e.sqlState === '57014') return true;
  // Last-resort message scan (some wrapping layers strip the .code).
  const msg = err instanceof Error ? err.message : String(err);
  return /canceling statement due to|query.*canceled|sqlstate[\s:]+57014/i.test(msg);
}

/**
 * Convert any 57014 error into a `StructuredAgentError` with the
 * brainstorm-specific hint. Non-57014 errors pass through unchanged
 * (caller rethrows). The hint deliberately covers the three PG cancel
 * sub-causes per codex F#19 so the message stays true when the cancel
 * was from a lock timeout or user-cancel, not just statement timeout.
 */
export function classifyBrainstormError(err: unknown): unknown {
  if (!isQueryCanceledError(err)) return err;
  return new StructuredAgentError({
    class: 'BrainstormError',
    code: 'brainstorm_timeout',
    message: 'Brainstorm query was canceled by Postgres',
    hint:
      'Causes: statement_timeout (often PgBouncer transaction-mode), lock_timeout, or user-cancel. ' +
      'Workarounds: try a smaller --limit, retry once, or ask your brain admin about ' +
      'statement_timeout / PgBouncer settings. The orchestrator entry-point wrap covers every internal SQL site.',
  });
}
