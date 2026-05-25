/**
 * v0.41 D3 + E6 — shared error classifier for minion jobs.
 *
 * Reads `minion_jobs.last_error` (or any equivalent error string) and
 * returns a stable bucket. Two consumers:
 *
 *   1. **D3 error clustering** — `gbrain jobs stats --cluster-errors` and
 *      `gbrain jobs get --cluster <name>` group dead/failed jobs by bucket
 *      so "92 jobs failed" becomes "92 jobs failed: 89 rate_lease_full,
 *      3 prompt_too_long" — the operator instantly knows the right fix.
 *
 *   2. **E6 self-fix** — `RECOVERABLE_CLUSTERS` lists the buckets that
 *      qualify for classifier-gated auto-resubmit. Narrowed per codex
 *      pass-2 #4: `tool_error` was too broad (catches crashes, schema
 *      mismatches, permission errors, real bugs). Only the safe sub-types
 *      qualify:
 *
 *        prompt_too_long     — semantic-aware reduction can fix this
 *        tool_schema_mismatch — model passed bad args; retry with error msg
 *        malformed_json      — model emitted bad JSON; "JSON only" retry
 *
 *      Explicitly NOT recoverable: tool_crash (real bug in tool impl),
 *      tool_unavailable (registry config issue), tool_permission
 *      (capability decision; needs human).
 *
 * Mirrors the pattern at `src/core/eval-contradictions/judge-errors.ts`.
 * Conservative: defaults to 'unknown' when no regex matches, so callers
 * always get a valid bucket (no nulls / undefined).
 */

export type ErrorCluster =
  | 'prompt_too_long'      // Anthropic 400 "prompt is too long"
  | 'tool_schema_mismatch' // model called tool with invalid arg shape
  | 'tool_crash'           // tool.execute threw an Error (real bug)
  | 'tool_unavailable'     // tool not in registry for this subagent
  | 'tool_permission'      // tool refused (e.g. put_page slug not allowed)
  | 'malformed_json'       // model output failed JSON parse where required
  | 'auth'                 // 401 / API key invalid
  | 'rate_limit'           // 429 from upstream
  | 'rate_lease_full'      // gbrain's internal RateLeaseUnavailableError
  | 'timeout'              // local timeout / abort
  | 'http_5xx'             // upstream 5xx
  | 'context_canceled'     // worker abort signal fired
  | 'unknown';

/**
 * Self-fix RECOVERABLE_CLUSTERS — narrowed per codex pass-2 #4.
 * Only these buckets trigger E6 auto-resubmit; everything else routes
 * through normal dead-letter so real bugs stay visible.
 */
export const RECOVERABLE_CLUSTERS = new Set<ErrorCluster>([
  'prompt_too_long',
  'tool_schema_mismatch',
  'malformed_json',
]);

/**
 * Classify a `last_error` string into a stable bucket. NULL / empty
 * input returns 'unknown'. Conservative — defaults to 'unknown' rather
 * than guess; lets D3 surface "unknown: N jobs" as a real signal that
 * the classifier set needs widening.
 */
export function classifyJobError(lastError: string | null | undefined): ErrorCluster {
  if (!lastError) return 'unknown';
  const msg = lastError.toLowerCase();

  // gbrain-internal errors first (most specific).
  if (/rate lease ".*" full/i.test(lastError)) return 'rate_lease_full';

  // Anthropic 400 prompt too long.
  if (/prompt is too long/i.test(lastError) || /context.*length/i.test(lastError)) {
    return 'prompt_too_long';
  }

  // Tool error sub-types. Order matters: more-specific patterns first.
  if (/tool ".*" is not (in the registry|available)/i.test(lastError)) {
    return 'tool_unavailable';
  }
  if (/tool ".*" (permission|forbidden|denied|not allowed)/i.test(lastError)) {
    return 'tool_permission';
  }
  if (/(invalid|malformed|missing) (input|argument|param|schema|field)/i.test(lastError) ||
      /tool_use validation/i.test(lastError) ||
      /required.*missing/i.test(lastError)) {
    return 'tool_schema_mismatch';
  }
  if (/tool ".*" (failed|crashed|threw)/i.test(lastError) ||
      /tool.execute.*error/i.test(lastError)) {
    return 'tool_crash';
  }

  // JSON shape errors.
  if (/(parse|invalid|malformed).*json/i.test(lastError) ||
      /expected json/i.test(lastError) ||
      /unexpected token.*in json/i.test(lastError)) {
    return 'malformed_json';
  }

  // HTTP / upstream errors.
  if (msg.includes('401') || msg.includes('unauthorized') || /api[- _]?key.*invalid/i.test(lastError)) {
    return 'auth';
  }
  if (msg.includes('429') || /rate[- _]?limit/i.test(lastError) || /too many requests/i.test(lastError)) {
    return 'rate_limit';
  }
  if (/\b50[0-9]\b/.test(msg) || msg.includes('bad gateway') || msg.includes('service unavailable') ||
      msg.includes('gateway timeout') || msg.includes('overloaded')) {
    return 'http_5xx';
  }

  // Local / control-plane signals.
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted: timeout')) {
    return 'timeout';
  }
  if (msg.includes('aborted: cancel') || msg.includes('signal aborted') || msg.includes('context canceled')) {
    return 'context_canceled';
  }

  return 'unknown';
}

/**
 * Cluster a list of error strings into bucket → count. Stable order:
 * counts descending, then bucket name ascending. Includes 'unknown' if
 * it shows up so operators see "N unknown" as a signal to widen the
 * classifier.
 */
export function clusterErrors(
  errors: Array<{ id: number; last_error: string | null }>,
): Array<{ cluster: ErrorCluster; count: number; sample_ids: number[] }> {
  const map = new Map<ErrorCluster, { count: number; sample_ids: number[] }>();
  for (const e of errors) {
    const c = classifyJobError(e.last_error);
    const bucket = map.get(c) ?? { count: 0, sample_ids: [] };
    bucket.count += 1;
    // Carry up to 3 sample ids per bucket for `--cluster <name>` lookup.
    if (bucket.sample_ids.length < 3) bucket.sample_ids.push(e.id);
    map.set(c, bucket);
  }
  return Array.from(map.entries())
    .map(([cluster, { count, sample_ids }]) => ({ cluster, count, sample_ids }))
    .sort((a, b) => (b.count - a.count) || a.cluster.localeCompare(b.cluster));
}
