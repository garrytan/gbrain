// v0.38 ReDoS guard (E6 + E9 refinement).
//
// Community schema packs ship arbitrary regexes in
// `link_types[].inference.regex`. A pack with catastrophic-backtracking
// pattern (`^(a+)+$` and friends) + a moderately-long paragraph would
// pin CPU on every link extraction.
//
// E6 locked `vm.runInContext({timeout: 50})` as the primary defense.
// E9 added two layers:
//   1. A Bun-vm spike (scripts/spike-bun-vm-timeout.ts) MUST run before
//      this guard is trusted in production. If the spike shows Bun's
//      vm timeout doesn't actually interrupt under catastrophic regex,
//      fall back to a persistent worker pool (E6 option B).
//   2. A per-PAGE total budget. `LINK_EXTRACTION_TOTAL_BUDGET_MS = 500`.
//      If cumulative regex time on a page exceeds 500ms, degrade ALL
//      remaining verbs on that page to `mentions`, deterministically
//      sorted by lex of verb name so degraded-link sets reproduce.
//
// This file ships the integration shape; the spike confirmation is
// gated by T24. If the spike fails, swap `runRegexBounded` with a
// worker-pool variant; the public surface stays the same.
//
// T24 spike result (2026-05-20): Bun's vm.runInContext({timeout: 50})
// DOES interrupt catastrophic regex, but with ~10x wall-clock latency
// versus the configured timeout. A configured 50ms timeout takes ~500ms
// wall-clock to actually unwind for `^(a+)+$` against a 1MB input. This
// is because Bun checks the timeout at instruction boundaries, and tight
// backtracking loops yield infrequently. The per-page budget design
// absorbs this: one catastrophic regex consumes the 500ms budget, all
// remaining verbs degrade to mentions. Total CPU per page is bounded by
// the budget regardless of pathological pattern count. SAFE for v0.38.
//
// v0.46 megawave FALSIFICATION (bootstrap-verify corpus hang): in a process
// that ALSO hosts PGLite (WASM Postgres), repeated `vm.runInContext(...,
// { timeout })` calls wedge Bun's event loop — after some dozens of watchdog
// runs, ALL JS timers stop firing and the next in-flight PGLite query promise
// never resolves (main thread parks in kevent64 at 0% CPU forever). Repro:
// put_page x ~20 with pack regex inference (#3190) against an in-memory
// PGLite brain; hang point drifts run-to-run. The vm timeout was therefore
// REMOVED — it protected against a slow regex by freezing the entire brain,
// strictly worse than the attack. This is likely the mechanism behind the
// #1569-followup field report of syncs wedging deterministically mid-run.
// Bounding is now: (1) the input-length cap below, (2) a runtime HARD gate
// refusing nested-quantifier (catastrophic-shape) patterns — the same
// heuristic the star-height lint flags, escalated from advisory to enforced
// at execution time (degrade-to-mentions, never executed), and (3) the
// per-page cumulative budget. If a true preemptive bound is ever needed
// again, it must be the E6 option B worker pool — NOT node:vm — because the
// watchdog is unsafe in PGLite-hosting processes.

export const LINK_EXTRACTION_TOTAL_BUDGET_MS = 500 as const;
export const PER_REGEX_TIMEOUT_MS = 50 as const;

// v0.41.37.0 #1569: hard input-length cap. Catastrophic backtracking needs a
// long input to blow up; a pack regex run against a multi-KB body is the blast
// radius. Capping the input length removes it cheaply — a link-extraction
// `context` is normally a sentence or short paragraph, so 64KB is generous.
// Over the cap, the regex is skipped (degrade-to-mentions) without ever
// executing. Paired with the runtime nested-quantifier refusal below (the
// star-height lint heuristic, enforced at execution time since the vm
// watchdog's removal). Env-overridable for power users with huge contexts.
export const MAX_REGEX_INPUT_CHARS = (() => {
  const raw = process.env.GBRAIN_MAX_REGEX_INPUT_CHARS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 64_000;
})();

/** Tagged error thrown when input exceeds MAX_REGEX_INPUT_CHARS. Treated as
 *  degrade-to-mentions by `PageRegexBudget.runBounded` (counts against budget). */
export class RegexInputTooLargeError extends Error {
  constructor(public readonly length: number) {
    super(`regex input ${length} chars exceeds cap ${MAX_REGEX_INPUT_CHARS}`);
    this.name = 'RegexInputTooLargeError';
  }
}

/**
 * Nested-quantifier (catastrophic-backtracking shape) heuristic: an inner
 * group containing a +/* quantifier, wrapped by an outer +/* quantifier —
 * `(a+)+`, `(a*)*`, `(\w+)+` and friends. Single source of truth: the
 * star-height LINT rule (`linkRegexCatastrophicBacktrack` in lint-rules.ts)
 * imports this same constant, and `runRegexBounded` below enforces it at
 * runtime (the pattern is REFUSED, never executed) now that the vm watchdog
 * is gone. Catches the common exponential class, not every possible one.
 */
export const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)\s*[+*]/;

/** Tagged error thrown when a pattern matches NESTED_QUANTIFIER_RE. Treated
 *  as degrade-to-mentions by `PageRegexBudget.runBounded` (counts against the
 *  budget), same contract as the oversize-input refusal above. */
export class RegexCatastrophicPatternError extends Error {
  constructor(public readonly pattern: string) {
    super(`regex pattern '${pattern}' has a nested quantifier (catastrophic-backtracking shape); refused`);
    this.name = 'RegexCatastrophicPatternError';
  }
}

export class RegexTimeoutError extends Error {
  readonly verb: string;
  readonly pattern: string;
  constructor(verb: string, pattern: string) {
    super(`regex for verb "${verb}" exceeded ${PER_REGEX_TIMEOUT_MS}ms timeout`);
    this.name = 'RegexTimeoutError';
    this.verb = verb;
    this.pattern = pattern;
  }
}

export class PageBudgetExceededError extends Error {
  readonly cumulativeMs: number;
  constructor(cumulativeMs: number) {
    super(`page link-extraction budget exceeded: ${cumulativeMs.toFixed(1)}ms > ${LINK_EXTRACTION_TOTAL_BUDGET_MS}ms`);
    this.name = 'PageBudgetExceededError';
    this.cumulativeMs = cumulativeMs;
  }
}

/**
 * Per-page execution context. Tracks cumulative regex time across the
 * extraction pass; degrades remaining verbs deterministically when the
 * budget is exhausted. Construct one per page; pass to `runRegexBounded`
 * for each verb's regex.
 */
export class PageRegexBudget {
  private cumulativeMs = 0;
  private exhausted = false;

  /**
   * Run a regex against text under the per-regex 50ms timeout. Returns
   * the match result (array or null), or undefined if the per-page
   * budget has been exhausted and this verb has been degraded.
   *
   * Codex F5 (deterministic degrade order): callers MUST sort verbs lex
   * before iterating so degraded sets reproduce across runs.
   */
  runBounded(verb: string, pattern: string, text: string): RegExpMatchArray | null | undefined {
    if (this.exhausted) {
      // Already over budget. Degrade silently — the caller is responsible
      // for treating undefined as "degrade to mentions".
      return undefined;
    }
    const start = performance.now();
    let match: RegExpMatchArray | null;
    try {
      match = runRegexBounded(pattern, text, PER_REGEX_TIMEOUT_MS);
    } catch (e) {
      // Treat timeout as degrade-to-mentions, not hard error.
      this.cumulativeMs += PER_REGEX_TIMEOUT_MS;
      if (this.cumulativeMs >= LINK_EXTRACTION_TOTAL_BUDGET_MS) {
        this.exhausted = true;
      }
      return null;
    }
    const elapsed = performance.now() - start;
    this.cumulativeMs += elapsed;
    if (this.cumulativeMs >= LINK_EXTRACTION_TOTAL_BUDGET_MS) {
      this.exhausted = true;
    }
    return match;
  }

  /** Diagnostic getter for tests + doctor metrics. */
  getCumulativeMs(): number { return this.cumulativeMs; }
  /** Whether the budget has been exhausted (subsequent calls return undefined). */
  isExhausted(): boolean { return this.exhausted; }
}

/**
 * Low-level bounded regex execution. Bounding is structural, not
 * preemptive (see the megawave falsification note in the header — the
 * node:vm watchdog wedges Bun's event loop in PGLite-hosting processes,
 * so it MUST NOT come back here):
 *   1. input-length cap (MAX_REGEX_INPUT_CHARS) — throws
 *      RegexInputTooLargeError, degrade-to-mentions upstream;
 *   2. catastrophic-shape refusal (NESTED_QUANTIFIER_RE) — throws
 *      RegexCatastrophicPatternError BEFORE the pattern ever executes;
 *   3. the caller's per-page cumulative budget (PageRegexBudget).
 *
 * `timeoutMs` is retained for signature compatibility and budget
 * accounting only; there is no in-flight interruption.
 *
 * NOTE: this is a single-shot match. Callers wanting global matches
 * should iterate via execAll or similar.
 */
export function runRegexBounded(
  pattern: string,
  text: string,
  _timeoutMs: number = PER_REGEX_TIMEOUT_MS,
): RegExpMatchArray | null {
  // v0.41.37.0 #1569: input-length cap first. Over the cap, skip the regex
  // entirely (the surrounding budget treats the throw as degrade).
  // Catastrophic backtracking can't blow up on input it never sees.
  if (text.length > MAX_REGEX_INPUT_CHARS) {
    throw new RegexInputTooLargeError(text.length);
  }
  // Hard gate: refuse nested-quantifier shapes outright (the lint rule's
  // heuristic, enforced). With no preemptive watchdog, an exponential
  // pattern must never reach exec().
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    throw new RegexCatastrophicPatternError(pattern);
  }
  try {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- this function IS the bounded-exec chokepoint for community pack regexes: input is capped at MAX_REGEX_INPUT_CHARS and nested-quantifier (catastrophic-backtracking) shapes are refused above BEFORE exec, and every caller routes through PageRegexBudget's per-page cumulative budget (see header: the vm-watchdog alternative wedges Bun+PGLite)
    return new RegExp(pattern).exec(text);
  } catch {
    // Malformed pattern (compile error). Treat as a degrade signal — the
    // caller counts it against the budget, same as before.
    throw new RegexTimeoutError('<unknown-verb>', pattern);
  }
}
