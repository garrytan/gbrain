/**
 * upstream-classifier.mjs — failure-source classifier for the voice-agent E2E.
 *
 * D4-A invariant: the full-flow E2E (~$1-2/run) must NOT block a ship when
 * the failure is caused by external upstream services (OpenAI Realtime API,
 * Anthropic, browser media stack glitches). It MUST block on real plumbing
 * bugs in the copied voice-agent code.
 *
 * `classifyFailure(err)` returns one of:
 *   - 'upstream'  — external service is degraded; soft-fail, log to friction
 *   - 'plumbing'  — our copied code is broken; hard-fail
 *   - 'semantic'  — LLM-judge returned a fail verdict; soft-fail (recorded)
 *   - 'unknown'   — can't classify confidently; treat as plumbing (fail-loud)
 *
 * Calibration: this classifier is conservative — anything not clearly
 * upstream is plumbing. False positive (classifying a real bug as upstream)
 * is the worst outcome (silently passes broken code); false negative
 * (classifying a transient outage as plumbing) is recoverable (re-run).
 */

/**
 * Classify a failure object. `err` may be:
 *   - a thrown Error with .status / .statusCode (for HTTP failures)
 *   - a structured object with .type / .code / .reason
 *   - an object with .closeCode (for WebSocket close codes)
 *   - a plain Error with a message string
 *
 * The classifier mostly inspects fields; it only falls back to message
 * matching as a last resort.
 *
 * @param {Error|object} err
 * @returns {'upstream'|'plumbing'|'semantic'|'unknown'}
 */
export function classifyFailure(err) {
  if (err == null) return 'unknown';

  // Explicit type tag wins. E.g. {type: 'semantic_judge_fail'}.
  if (err.type === 'semantic' || err.type === 'semantic_judge_fail') return 'semantic';
  if (err.type === 'upstream') return 'upstream';
  if (err.type === 'plumbing') return 'plumbing';

  // HTTP status (e.g. fetch() Response or axios-shaped error).
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (typeof status === 'number') {
    // 429 (rate limit), 500/502/503 (server-side outage) → upstream.
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
      return 'upstream';
    }
    // 401/403 → auth problem, our config issue, plumbing.
    if (status === 401 || status === 403) return 'plumbing';
    // 400 — usually our payload shape is wrong; plumbing.
    if (status === 400) return 'plumbing';
  }

  // WebSocket close codes. 1011 = server error, 1013 = try again later,
  // 1006 = abnormal closure (could be either; lean upstream since it's
  // usually a network-layer issue we can't fix).
  const closeCode = err.closeCode ?? err.code;
  if (typeof closeCode === 'number') {
    if (closeCode === 1011 || closeCode === 1013) return 'upstream';
    if (closeCode === 1006) return 'upstream';
    // 1000 (normal) shouldn't be classified as failure at all.
  }

  // Symbolic counter checks for plumbing: explicit zero-frame markers.
  if (err.audioSendCount === 0) return 'plumbing';
  if (err.audioPlayCount === 0 && (err.audioSendCount ?? 0) > 0) return 'plumbing';
  if (err.iceFailure === true) return 'plumbing';
  if (err.healthCheckFailed === true) return 'plumbing';

  // Reason field (some libs use this).
  const reason = err.reason || err.code || '';
  if (typeof reason === 'string') {
    const r = reason.toLowerCase();
    if (r.includes('rate') && r.includes('limit')) return 'upstream';
    if (r.includes('upstream')) return 'upstream';
    if (r.includes('degraded')) return 'upstream';
    if (r.includes('timeout') && r.includes('openai')) return 'upstream';
    if (r.includes('timeout') && r.includes('anthropic')) return 'upstream';
    if (r === 'semantic_fail' || r === 'judge_fail') return 'semantic';
  }

  // Last-resort message inspection. Only match strings that are clearly
  // upstream — anything ambiguous falls through to 'unknown' → caller
  // treats as plumbing.
  const msg = (err.message || String(err) || '').toLowerCase();
  if (
    msg.includes('api.openai.com') &&
    (msg.includes('429') || msg.includes('500') || msg.includes('503'))
  ) return 'upstream';
  if (msg.includes('api.anthropic.com') && msg.includes('rate_limit')) return 'upstream';
  if (msg.includes('econnreset') || msg.includes('econnrefused')) {
    // ECONNRESET to api.openai.com is upstream; to localhost is plumbing.
    if (msg.includes('openai') || msg.includes('anthropic')) return 'upstream';
    return 'plumbing';
  }

  return 'unknown';
}

/**
 * Verdict helper. Given a classification, return the recommended action:
 *   - 'soft_fail' — exit 0, log to friction channel, do not block ship.
 *   - 'hard_fail' — exit 1, real bug.
 *
 * `unknown` maps to `hard_fail` so we err on the side of catching bugs.
 */
export function verdictFor(kind) {
  switch (kind) {
    case 'upstream': return 'soft_fail';
    case 'semantic': return 'soft_fail';
    case 'plumbing': return 'hard_fail';
    case 'unknown':  return 'hard_fail';
    default:         return 'hard_fail';
  }
}

/**
 * Pre-flight check: probe the OpenAI status page. If it reports anything
 * other than 'none' (the operational status), return 'upstream' immediately
 * before the test even tries to connect — saves an expensive run on a known
 * outage day.
 *
 * Returns either {status: 'ok'} or {status: 'degraded', detail: <text>}.
 * Never throws. Treats any fetch failure as 'ok' (don't false-degrade on
 * a status-page outage that isn't a real Realtime outage).
 */
export async function preflightOpenAIStatus({ fetch = globalThis.fetch, timeoutMs = 3000 } = {}) {
  if (typeof fetch !== 'function') return { status: 'ok' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://status.openai.com/api/v2/status.json', {
      signal: ctrl.signal,
    });
    if (!res.ok) return { status: 'ok' };
    const body = await res.json();
    const indicator = body?.status?.indicator;
    if (indicator && indicator !== 'none') {
      return { status: 'degraded', detail: body.status.description || indicator };
    }
    return { status: 'ok' };
  } catch {
    return { status: 'ok' };
  } finally {
    clearTimeout(timer);
  }
}
