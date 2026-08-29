/**
 * v0.36.1.0 (T3) — propose_takes cycle phase.
 *
 * Scans markdown pages updated since last run, sends each page's prose to
 * a tuned LLM extractor, writes the extracted gradeable claims to the
 * `take_proposals` queue. User accepts/rejects via `gbrain takes propose`.
 *
 * Idempotency contract (D17 schema spec):
 *   The unique index on (source_id, page_slug, content_hash, prompt_version)
 *   means an unchanged page never re-spends LLM tokens. Bumping
 *   PROPOSE_TAKES_PROMPT_VERSION cleanly invalidates the cache so a tuned
 *   prompt re-runs proposals on every page.
 *
 * F2 fence dedup:
 *   The phase reads the page's existing `<!-- gbrain:takes:begin -->` fence
 *   (when present) and passes the canonical take rows to the extractor as
 *   "things you have already captured." This prevents duplicate proposals
 *   when a user adds prose to a page that already has takes.
 *
 * Auto-resolve posture:
 *   propose_takes only WRITES proposals to the queue. Nothing here mutates
 *   the canonical takes table. Operator opt-in via `gbrain takes propose
 *   --accept N` is the only path from queue to canonical fence (D17).
 *
 * Prompt tuning status (v0.36.1.0 ship state):
 *   The default extractor prompt was tuned against the synthetic corpus at
 *   test/fixtures/calibration/ and validated via the cat15 propose_takes
 *   eval in the gbrain-evals repo. First live run scored 0.952 F1 on
 *   training (target 0.85) and 0.922 F1 on holdout (target 0.80), with a
 *   0.03 train-holdout gap (no overfitting). PROPOSE_TAKES_PROMPT_VERSION
 *   is "v0.36.1.0-tuned-cat15". Re-tuning requires re-running cat15;
 *   bumping the version string invalidates the take_proposals idempotency
 *   cache so old proposals stay as audit history but the next cycle
 *   re-extracts fresh against the new prompt.
 *
 * The extractor LLM call is INJECTED via opts.extractor for tests, so the
 * phase can run hermetically in unit tests without touching the gateway.
 */

import { randomUUID, createHash } from 'node:crypto';
import { BaseCyclePhase, CYCLE_DEADLINE_RESERVE_MS, type ScopedReadOpts, type BasePhaseOpts } from './base-phase.ts';
import { defaultTimeoutMsFor } from '../minions/handler-timeouts.ts';
import { chat as gatewayChat, getChatModel, probeChatModel } from '../ai/gateway.ts';
import { createGlobalLlmHaltTracker, haltedClassOf, type GlobalLlmErrorClass } from '../ai/errors.ts';
import { normalizeModelId } from '../model-id.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup, classifyRunStop } from '../extract/rollup-writer.ts';
import { GBrainError } from '../types.ts';
import { isConfigTruthy } from '../config.ts';
import type { OperationContext } from '../operations.ts';
import type { BrainEngine } from '../engine.ts';
import type { PhaseStatus, CyclePhase } from '../cycle.ts';

/**
 * Bump when the extractor prompt or the JSON output shape changes. Old
 * verdicts in `take_proposals` (composite key includes prompt_version) stay
 * valid as audit history; new runs re-spend LLM tokens on every page.
 */
export const PROPOSE_TAKES_PROMPT_VERSION = 'v0.36.1.0-tuned-cat15';

/**
 * Sentinel claim_text for the tombstone row written when a page extracts
 * ZERO gradeable claims. Without a tombstone the idempotency tuple is never
 * recorded, so every cycle re-spends an LLM call on unchanged zero-claim
 * prose — the "unchanged page never re-spends tokens" contract only held
 * for pages that produced >=1 claim. The tombstone is inserted with
 * status='rejected' so no pending-review query surfaces it as a live
 * proposal; its only job is to make the next cycle a cache hit.
 */
export const EMPTY_EXTRACTION_TOMBSTONE_TEXT = '(no gradeable claims)';

/**
 * Tuned extractor prompt, validated against the hand-labeled synthetic
 * corpus at test/fixtures/calibration/. Measured F1 on first live run
 * via gbrain-evals cat15 (claude-sonnet-4-6 extractor, claude-haiku-4-5
 * matcher judge):
 *
 *   training avg F1: 0.952 (target 0.85, exceeded by 10 points)
 *   holdout  avg F1: 0.922 (target 0.80, exceeded by 12 points)
 *   train-holdout gap: 0.03 (no overfitting signal)
 *
 * Per-genre F1 floor: 0.80 (people-pages, the hardest genre). The
 * concept-with-timeline and meeting-notes genres scored at 1.00 on
 * holdout pages.
 *
 * Design choices baked into the prompt:
 *   - Worked example list seeds the model's notion of "gradeable claim"
 *     so it doesn't drift into pure-fact extraction.
 *   - NOT-gradeable list catches the most common over-extraction modes
 *     (pure facts, direct quotes, restatements).
 *   - conviction inference rules anchored to specific hedging language
 *     ("I bet"/"strong conviction"=0.7-0.85, "I think"/"moderate"=0.5-0.7).
 *   - kind enum kept narrow ('prediction'|'judgment'|'bet') — the v1
 *     stub's 4-tag enum bled into noise classification.
 *
 * Replaces the v0.36.1.0-stub. If you re-tune, run cat15 against the
 * fixtures before bumping PROPOSE_TAKES_PROMPT_VERSION; the train-holdout
 * gap should stay < 0.10 (overfitting threshold).
 */
export const EXTRACT_TAKES_PROMPT = `Extract gradeable claims from the prose below.

A "gradeable claim" is a prediction, recommendation, or interpretive judgment
that could turn out wrong over time. Examples:
- "X company will hit ARR milestone by Q3" (prediction)
- "Y founder is going to struggle with execution" (judgment)
- "Z market will compress in 18 months" (prediction)
- "I bet alice wins the round" (bet)

NOT gradeable (do NOT extract these):
- Pure facts ("X was founded in 2020")
- Direct quotes from others without endorsement
- Restatements of an earlier claim in the same page

For each gradeable claim, output a JSON object with:
- claim_text   (string, <=200 chars, paraphrase or near-verbatim from prose)
- kind         ('prediction' | 'judgment' | 'bet')
- holder       ('world' | 'people/<slug>' | 'companies/<slug>' | 'brain' — default 'brain' when author asserts the claim)
- weight       (number 0..1 inferred from hedging language: 'I bet'/'strong conviction'=0.7-0.85,
                'I think'/'moderate conviction'=0.5-0.7, 'maybe'/'I'd guess'=0.3-0.5)
- domain       (short tag — e.g. 'tactics', 'macro', 'hiring', 'geography', 'pricing')

Output ONLY a JSON array of these objects. No prose. No commentary. If no
gradeable claims, return [].

EXISTING FENCE ROWS (already captured — do NOT propose duplicates):
{EXISTING_TAKES_JSON}

PAGE PROSE:
{PAGE_BODY}
`;

/** One proposed take, as the extractor produces it. */
export interface ProposedTake {
  claim_text: string;
  kind: 'fact' | 'take' | 'bet' | 'hunch';
  holder: string;
  weight: number;
  domain?: string;
}

/** Extractor function signature — injected for tests; production calls gateway. */
export type ProposeTakesExtractor = (input: {
  pagePath: string;
  pageBody: string;
  existingTakes: Array<{ claim: string; kind: string; holder: string; weight: number }>;
  modelHint?: string;
  /**
   * #4494: output cap for the extractor call (default
   * PROPOSE_TAKES_MAX_TOKENS). Configurable via dream.propose_takes.max_tokens
   * because thinking models spend reasoning tokens INSIDE maxTokens — at the
   * 2048 default a thinking model can burn the whole budget before emitting
   * any JSON, truncating EVERY page into a permanent per-page retry loop.
   */
  maxTokens?: number;
  /** #4494: escalated cap for the one truncation retry (default
   *  PROPOSE_TAKES_RETRY_MAX_TOKENS; clamped to >= maxTokens). */
  retryMaxTokens?: number;
}) => Promise<ProposedTake[]>;

export interface ProposeTakesOpts extends BasePhaseOpts {
  /** Brain repo root for fs-source page walking. Optional — defaults to engine pages. */
  repoPath?: string;
  /** Limit pages processed in this cycle (for triage / quick smoke). Default: 100. */
  pageLimit?: number;
  /** Inject the LLM call for tests; production uses gateway.chat. */
  extractor?: ProposeTakesExtractor;
  /** Override prompt_version (tests). */
  promptVersion?: string;
  /** Override model id (tests + config). */
  model?: string;
  /** Skip pages that already have a complete takes fence. Default: true. */
  skipPagesWithFence?: boolean;
  /** Override the phase wall-clock deadline (tests). Default: 30 min. */
  deadlineMs?: number;
  /**
   * #4102 — `gbrain dream --phase propose_takes --once` bypasses the
   * `cycle.propose_takes.enabled` off switch for THIS call only (mirrors the
   * conversation_facts_backfill `once` semantics; never reads/writes config).
   */
  once?: boolean;
}

export interface ProposeTakesResult {
  pages_scanned: number;
  cache_hits: number;
  cache_misses: number;
  proposals_inserted: number;
  /** Idempotency rows written for pages that extracted zero claims. */
  tombstones_written: number;
  budget_exhausted: boolean;
  /** True when the phase deadline fired before the page loop completed (partial result). */
  deadline_hit?: boolean;
  /**
   * Set when the page loop broke on a whole-run LLM failure (#3044):
   * auth/billing on the first hit, rate_limit after RATE_LIMIT_HALT_STREAK
   * consecutive hits. The phase reports 'warn' ('fail' when NO extractor
   * call succeeded) and the rollup records a halt so the condition can't
   * hide behind a green summary.
   */
  aborted_global_error?: GlobalLlmErrorClass;
  /**
   * #3763: set when the page loop halted because EVERY extractor call failed
   * (zero successes) for EXTRACTOR_FAILURE_HALT_STREAK consecutive pages —
   * a dead extractor lane (bad model id, broken recipe, systematic truncation)
   * that would otherwise re-bill every remaining page. Folds into `halted`
   * and reports the phase as 'fail'.
   */
  aborted_failure_streak?: boolean;
  /** Extractor calls that returned (idempotency cache hits don't count). */
  llm_calls_succeeded: number;
  /** Extractor calls that threw (global or per-page alike). */
  llm_calls_failed: number;
  warnings: string[];
}

/** Narrow projection of `pages` — the only columns this phase reads. */
interface ProposeTakesPageRow {
  slug: string;
  source_id: string;
  compiled_truth: string | null;
}

/**
 * Load proposal candidates with a narrow projection instead of
 * `engine.listPages` (`SELECT p.*`). The phase only reads slug, source_id
 * and compiled_truth — skipping timeline/frontmatter/title keeps large
 * toasted columns out of the hot path. Scope precedence mirrors
 * `sourceScopeOpts`: federated array (`sourceIds`) beats scalar
 * (`sourceId`); ordering matches `PAGE_SORT_SQL.updated_desc` with an id
 * tiebreak for determinism. (Takeover of PR #1979's projection by
 * @shawnduggan.)
 */
async function listCandidatePages(
  engine: BrainEngine,
  scope: ScopedReadOpts,
  limit: number,
): Promise<ProposeTakesPageRow[]> {
  const where = [
    'deleted_at IS NULL',
    "type IS DISTINCT FROM 'extract_receipt'",
  ];
  const params: unknown[] = [];
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    where.push(`source_id = $${params.length}`);
  }
  params.push(limit);
  return engine.executeRaw<ProposeTakesPageRow>(
    `SELECT slug, source_id, compiled_truth
       FROM pages
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
}

/**
 * Compute the content_hash key for the idempotency cache. SHA-256 of the
 * page body suffices — page slug + prompt_version are separate columns in
 * the composite unique index.
 */
export function contentHash(pageBody: string): string {
  return createHash('sha256').update(pageBody).digest('hex');
}

/**
 * Detect whether a page already has a complete `<!-- gbrain:takes:begin -->`
 * fence. We DO propose against pages with fences (F2 dedup) but the operator
 * may opt to skip-with-fence pages via skipPagesWithFence:true for a faster
 * pass. The fence shape mirrors src/core/takes-fence.ts.
 */
export function hasCompleteFence(pageBody: string): boolean {
  return /<!---?\s*gbrain:takes:begin[\s\S]*?gbrain:takes:end\s*-->/.test(pageBody);
}

/**
 * Parse the existing fence into rows so the extractor can dedupe.
 * Returns [] when no fence is present. Best-effort — malformed fences
 * surface to the operator via the existing v0.28 fence parser, not here.
 */
export function extractExistingTakesForDedup(pageBody: string): Array<{
  claim: string;
  kind: string;
  holder: string;
  weight: number;
}> {
  const fenceMatch = pageBody.match(/<!---?\s*gbrain:takes:begin\s*-->([\s\S]*?)<!---?\s*gbrain:takes:end\s*-->/);
  if (!fenceMatch) return [];
  const body = fenceMatch[1] ?? '';
  const rows: Array<{ claim: string; kind: string; holder: string; weight: number }> = [];
  for (const line of body.split('\n')) {
    const cells = line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    // Skip header + separator rows.
    if (cells.length < 4) continue;
    if (cells[0] === '#' || cells[0]?.match(/^-+$/)) continue;
    const claim = cells[1] ?? '';
    if (!claim || claim.startsWith('~~')) continue; // strikethrough = inactive, doesn't count for dedup
    const kind = cells[2] ?? 'take';
    const holder = cells[3] ?? 'brain';
    const weight = Number.parseFloat(cells[4] ?? '0.5');
    rows.push({
      claim: claim.replace(/^~~|~~$/g, ''),
      kind,
      holder,
      weight: Number.isFinite(weight) ? weight : 0.5,
    });
  }
  return rows;
}

/** Per-call wall-clock timeout for the extractor LLM call. */
const EXTRACTOR_CALL_TIMEOUT_MS = 90_000;

/**
 * #3763 — output caps for the extractor call. A stopReason 'length' response
 * at the base cap retries ONCE at the escalated cap (facts/extract.ts #2113
 * parity); a still-truncated retry throws an error NAMING the truncation
 * instead of the old generic 'transient — retry' (which re-billed the page
 * every cycle forever while hiding the real cause).
 *
 * #4494 — these are now DEFAULTS, overridable via
 * `dream.propose_takes.max_tokens` / `dream.propose_takes.retry_max_tokens`
 * (floor 256; retry clamped >= base), mirroring dream.triage.max_tokens.
 * Thinking models (DeepSeek-R1, MiniMax-M3, Claude with extended thinking)
 * spend reasoning tokens INSIDE the maxTokens budget, so field deployments
 * saw every dense page truncate at 2048 → retry at 4096 → truncate again →
 * throw → re-bill next cycle, forever. Raising the config key breaks that
 * loop without inflating the default for non-thinking models.
 */
export const PROPOSE_TAKES_MAX_TOKENS = 2048;
export const PROPOSE_TAKES_RETRY_MAX_TOKENS = 4096;

/**
 * #3763 — halt streak for a dead extractor lane. When EVERY extractor call in
 * the run has failed (zero successes) and the failure count reaches this
 * streak, the page loop halts instead of burning an LLM call (and its input
 * tokens) on every remaining page. Any single success disarms the halt for
 * the rest of the run — a mixed run is per-page noise, not a dead lane.
 * Deliberately NO failure tombstone (#3910 policy): failed pages retry next
 * cycle once the underlying cause clears.
 */
export const EXTRACTOR_FAILURE_HALT_STREAK = 5;

/**
 * Production extractor — calls gateway.chat with the EXTRACT_TAKES_PROMPT
 * and parses the JSON array output. Returns [] on parse failure (logged as
 * warning, not thrown — one bad page must not abort the phase).
 *
 * Stub-prompt note: the v0.36.1.0 ship-state prompt is a placeholder. Real
 * extractor lands when T19 corpus build produces the tuned prompt. Until
 * then, the production extractor returns whatever the stub LLM produces —
 * empirically often a sparse list or [].
 */
export async function defaultExtractor(
  input: Parameters<ProposeTakesExtractor>[0],
): Promise<ProposedTake[]> {
  const prompt = EXTRACT_TAKES_PROMPT
    .replace('{EXISTING_TAKES_JSON}', JSON.stringify(input.existingTakes, null, 2))
    .replace('{PAGE_BODY}', input.pageBody);

  // #4494: per-run configurable caps (dream.propose_takes.max_tokens /
  // .retry_max_tokens), threaded by the phase; the #3763 constants stay as
  // defaults. Retry is clamped >= base so a partial override can't shrink
  // the escalation below the first attempt.
  const baseMaxTokens = Math.max(256, Math.floor(input.maxTokens ?? PROPOSE_TAKES_MAX_TOKENS));
  const retryMaxTokens = Math.max(
    baseMaxTokens,
    Math.floor(input.retryMaxTokens ?? PROPOSE_TAKES_RETRY_MAX_TOKENS),
  );

  // Bound each call so one stalled provider socket can't pin the phase for the
  // full gateway default (GBRAIN_AI_CHAT_TIMEOUT_MS, 300s) x pageLimit. The
  // caller already catches per-page errors, logs a warning, and continues.
  const call = (maxTokens: number) => gatewayChat({
    messages: [{ role: 'user', content: prompt }],
    ...(input.modelHint ? { model: input.modelHint } : {}),
    maxTokens,
    abortSignal: AbortSignal.timeout(EXTRACTOR_CALL_TIMEOUT_MS),
  });
  let result = await call(baseMaxTokens);

  // #3763: a truncated response (stopReason 'length' — e.g. reasoning tokens
  // eating the cap, or a dense page extracting many claims) produced
  // unparseable JSON that the ambiguity guard below rethrew as a GENERIC
  // 'transient — retry', so the page was re-billed at the same too-small cap
  // every cycle forever. Retry ONCE at the escalated cap (#2113 parity);
  // still-truncated throws a message that NAMES the truncation so the phase
  // warning tells the operator what actually happened.
  if (result.stopReason === 'length') {
    process.stderr.write(
      `[propose_takes] WARN: extractor output truncated at maxTokens=${baseMaxTokens} ` +
      `(${input.pagePath}); retrying once at ${retryMaxTokens}\n`,
    );
    result = await call(retryMaxTokens);
    if (result.stopReason === 'length') {
      throw new Error(
        `propose_takes extractor: output truncated (stopReason=length) even at ` +
        `maxTokens=${retryMaxTokens} on ${input.pagePath} — ` +
        `page prose extracts more than the cap can carry; raise ` +
        `dream.propose_takes.max_tokens (thinking models spend reasoning tokens ` +
        `inside this budget); no tombstone written, page retries next cycle`,
      );
    }
  }

  // ChatResult.text is already the concatenated text content.
  const takes = parseExtractorOutput(result.text);
  // A parse-level `[]` is AMBIGUOUS: it means either "the model genuinely
  // found no gradeable claims" OR "the model returned malformed/prose/
  // truncated output we couldn't parse." The caller memoizes empty
  // extractions with a tombstone, so a transient parse failure would
  // PERMANENTLY suppress a page that actually has claims. Only a cleanly
  // parsed empty array is a real "no claims" result worth memoizing; treat
  // anything else as a transient error and throw, so the phase's catch
  // retries the page next cycle (writing no tombstone).
  if (takes.length === 0 && !isWellFormedEmptyExtraction(result.text)) {
    throw new Error('propose_takes extractor: no parseable takes JSON (transient — retry)');
  }
  return takes;
}

/**
 * True only when `raw` is a cleanly-parseable EMPTY JSON array — the
 * well-behaved "no gradeable claims" response (the prompt instructs the model
 * to return `[]`). Distinguishes a genuine empty extraction (safe to memoize
 * via a tombstone) from malformed / prose / truncated output (transient —
 * must be retried, never tombstoned). Mirrors parseExtractorOutput's
 * think-strip + fence-strip + first-array handling so both agree on what
 * "the model returned []" means.
 */
export function isWellFormedEmptyExtraction(raw: string): boolean {
  if (!raw || raw.trim().length === 0) return false;
  let text = raw.trim();
  // Strip <think>...</think> reasoning tags (MiniMax-M3, DeepSeek-R1, etc.),
  // same as parseExtractorOutput (#2559).
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  const arrStart = text.indexOf('[');
  if (arrStart === -1) return false;
  try {
    const parsed = JSON.parse(text.slice(arrStart));
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/**
 * Parse extractor output into ProposedTake[]. Handles common LLM output
 * sins (markdown fence wrapping, leading/trailing prose, single-object
 * instead of array). Returns [] on any unrecoverable parse error rather
 * than throwing.
 */
export function parseExtractorOutput(raw: string): ProposedTake[] {
  if (!raw || raw.trim().length === 0) return [];
  let text = raw.trim();
  // Strip <think>...</think> reasoning tags (MiniMax-M3, DeepSeek-R1, etc.).
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Strip markdown code fence wrapper.
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  // First-array-or-object substring extraction (defends against leading prose).
  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  if (firstArr === -1 && firstObj === -1) return [];
  const start = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) ? firstArr : firstObj;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    // Fallback: truncate at last ] or } to handle trailing noise (e.g. leftover
    // markdown fences after <think> stripping). Try array-closing first.
    const sliced = text.slice(start);
    const lastArr = sliced.lastIndexOf(']');
    const lastObj = sliced.lastIndexOf('}');
    const end = Math.max(lastArr, lastObj);
    if (end > 0) {
      try {
        parsed = JSON.parse(sliced.slice(0, end + 1));
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProposedTake[] = [];
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const claim_text = typeof r.claim_text === 'string' ? r.claim_text.trim() : '';
    if (!claim_text || claim_text.length > 500) continue;
    const kind = ['fact', 'take', 'bet', 'hunch'].includes(r.kind as string)
      ? (r.kind as ProposedTake['kind'])
      : 'take';
    const holder = typeof r.holder === 'string' && r.holder.length > 0 ? r.holder : 'brain';
    const weightRaw = typeof r.weight === 'number' ? r.weight : 0.5;
    const weight = Math.max(0, Math.min(1, weightRaw));
    const domain = typeof r.domain === 'string' && r.domain.length > 0 ? r.domain : undefined;
    out.push({ claim_text, kind, holder, weight, domain });
  }
  return out;
}

/**
 * BaseCyclePhase subclass. Walks pages, checks idempotency cache, calls
 * extractor, writes proposals.
 */
/**
 * #4168 — the phase deadline is DERIVED, never a literal. The old
 * PHASE_DEADLINE_MS thirty-minute literal was bit-identical to the
 * autopilot-cycle handler anchor (and the clocks were not even co-started:
 * the job clock starts at claim, this phase starts LATE in ALL_PHASES), so
 * the clean-exit `deadline_hit` path was structurally unreachable in
 * production — cycles died on wall-clock instead of completing partial and
 * `cycle_freshness` never advanced. Same duplicated-literal class as #2781.
 *
 * Fail-loud derivation (autopilot-timeout.ts precedent): a missing handler
 * anchor throws HERE, at module load — which propagates through cycle.ts's
 * dynamic import and fails the WHOLE cycle visibly rather than one phase
 * silently. Accepted trade; the drift-guard test pins the inequality.
 */
function requireCycleAnchorMs(): number {
  const ms = defaultTimeoutMsFor('autopilot-cycle');
  if (ms === null) {
    throw new Error(
      "propose_takes: 'autopilot-cycle' has no entry in HANDLER_DEFAULT_TIMEOUT_MS " +
      '(handler-timeouts.ts) — the phase deadline can no longer be derived from it. See #4168.',
    );
  }
  return ms;
}

/** Headroom for grade_takes + calibration_profile, which run AFTER this
 *  phase in the same calibration block with no deadline of their own. */
export const PHASE_DEADLINE_FRACTION_OF_JOB = 0.8;
export const PROPOSE_TAKES_FALLBACK_DEADLINE_MS = Math.floor(
  requireCycleAnchorMs() * PHASE_DEADLINE_FRACTION_OF_JOB,
);
/** Mirrors MIN_PATTERNS_SUBAGENT_BUDGET_MS: below this the phase cannot do
 *  useful LLM work before the job's kill switch — skip honestly instead. */
export const MIN_PROPOSE_TAKES_BUDGET_MS = 2 * 60 * 1000;

/**
 * Resolve the phase's wall-clock budget from the REAL remaining job time
 * when it is known. Shaped like patterns.ts's clampSubagentBudgets: null
 * means "not worth starting" (caller returns an honest skip). Pure —
 * unit-testable without an engine.
 */
export function resolveProposeTakesDeadlineMs(
  deadlineAtMs: number | null | undefined,
  nowMs: number,
): number | null {
  if (deadlineAtMs == null) return PROPOSE_TAKES_FALLBACK_DEADLINE_MS;
  const remaining = deadlineAtMs - CYCLE_DEADLINE_RESERVE_MS - nowMs;
  // Red-team + adversarial F4: the grade_takes/calibration_profile headroom
  // the 0.8 fraction exists for must apply on the THREADED path too, and the
  // MIN floor must gate the FRACTIONED value — clamping a sub-MIN fraction
  // back UP to MIN would hand propose_takes the whole remaining window and
  // start the downstream phases inside the reserve. Under the floor, skip
  // honestly instead.
  const fractioned = Math.floor(remaining * PHASE_DEADLINE_FRACTION_OF_JOB);
  if (fractioned < MIN_PROPOSE_TAKES_BUDGET_MS) return null;
  return Math.min(fractioned, PROPOSE_TAKES_FALLBACK_DEADLINE_MS);
}

class ProposeTakesPhase extends BaseCyclePhase {
  readonly name = 'propose_takes' as CyclePhase;
  protected readonly budgetUsdKey = 'cycle.propose_takes.budget_usd';
  protected readonly budgetUsdDefault = 5.0;

  protected override mapErrorCode(err: unknown): string {
    if (err instanceof GBrainError) return err.problem;
    if (err instanceof Error) {
      if (err.message.includes('content_hash')) return 'CALIBRATION_PROPOSAL_DEDUP_FAIL';
      if (err.message.includes('budget') || err.message.includes('Budget')) return 'CALIBRATION_GRADE_BUDGET_EXHAUSTED';
    }
    return 'PROPOSE_TAKES_UNKNOWN';
  }

  protected async process(
    engine: BrainEngine,
    scope: ScopedReadOpts,
    _ctx: OperationContext,
    opts: ProposeTakesOpts,
  ): Promise<{ summary: string; details: Record<string, unknown>; status?: PhaseStatus }> {
    // #4102 — off switch. The phase is ON by default (it ships in the default
    // phase list), but `gbrain config set cycle.propose_takes.enabled false`
    // must actually stop the LLM spend. Only an EXPLICIT falsy value skips
    // (unset = default on, fail-open on read errors so a config-plane blip
    // never silently disables the phase); `--once` bypasses for one run.
    if (!opts.once) {
      let enabledRaw: string | null = null;
      try {
        enabledRaw = await engine.getConfig?.('cycle.propose_takes.enabled') ?? null;
      } catch {
        enabledRaw = null;
      }
      if (enabledRaw != null && !isConfigTruthy(enabledRaw)) {
        return {
          summary: 'propose_takes skipped: cycle.propose_takes.enabled=false',
          details: {
            reason: 'disabled',
            enable_hint: 'gbrain config set cycle.propose_takes.enabled true',
            pages_scanned: 0,
            cache_hits: 0,
            cache_misses: 0,
            proposals_inserted: 0,
            tombstones_written: 0,
            budget_exhausted: false,
            warnings: [],
          },
          status: 'skipped',
        };
      }
    }

    const extractor = opts.extractor ?? defaultExtractor;
    const promptVersion = opts.promptVersion ?? PROPOSE_TAKES_PROMPT_VERSION;
    const pageLimit = opts.pageLimit ?? 100;
    const skipPagesWithFence = opts.skipPagesWithFence ?? false;
    // gbrain#4168: explicit test override wins; otherwise the REAL remaining
    // job budget (when the cycle threads deadlineAtMs) clamped to the derived
    // fallback. At the default installed-daemon interval the old 30-min
    // literal was bit-identical to the job timeout floor, and since this
    // phase starts after earlier phases, phase-elapsed always trailed
    // job-elapsed — the clean partial-exit below was unreachable and cycles
    // dead-lettered instead of banking work. Resolved to null = not enough
    // budget to start (see the honest-skip return after the provider probe).
    const resolvedDeadlineMs =
      opts.deadlineMs ?? resolveProposeTakesDeadlineMs(opts.deadlineAtMs, Date.now());
    const phaseStartMs = Date.now();
    const proposalRunId = `propose-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 8)}`;

    const modelId = opts.model ?? getChatModel();

    // #4494: configurable extractor output caps (dream.triage.max_tokens
    // precedent — floor 256, retry clamped >= base, fail-open to the #3763
    // defaults on any config-plane error). Thinking models spend reasoning
    // tokens inside maxTokens, so the hardcoded 2048/4096 pair put dense
    // pages into a permanent truncate → retry → truncate → re-bill loop.
    let extractorMaxTokens = PROPOSE_TAKES_MAX_TOKENS;
    let extractorRetryMaxTokens = PROPOSE_TAKES_RETRY_MAX_TOKENS;
    try {
      const readCap = async (key: string): Promise<number | null> => {
        const raw = await engine.getConfig?.(key);
        if (raw == null || String(raw).trim() === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      };
      const baseCap = await readCap('dream.propose_takes.max_tokens');
      if (baseCap != null) extractorMaxTokens = Math.max(256, Math.floor(baseCap));
      const retryCap = await readCap('dream.propose_takes.retry_max_tokens');
      if (retryCap != null) extractorRetryMaxTokens = Math.floor(retryCap);
    } catch { /* keep defaults */ }
    extractorRetryMaxTokens = Math.max(extractorMaxTokens, extractorRetryMaxTokens);

    // With the default (gateway) extractor, skip cheaply when the resolved
    // model's provider can't run — same probe semantics as patterns.ts /
    // think/index.ts: unknown provider/model or Anthropic-without-key skips;
    // other providers' auth surfaces lazily at chat() time. An injected
    // extractor bypasses the gateway, so it is never gated. (Takeover of
    // PR #1979's intent by @shawnduggan.)
    if (!opts.extractor) {
      const probe = probeChatModel(normalizeModelId(modelId));
      if (!probe.ok) {
        return {
          summary: `propose_takes skipped: ${probe.detail}`,
          details: {
            reason: 'no_provider',
            model: modelId,
            pages_scanned: 0,
            cache_hits: 0,
            cache_misses: 0,
            proposals_inserted: 0,
            budget_exhausted: false,
            warnings: [],
          },
          status: 'skipped',
        };
      }
    }

    // #4168 honest skip — placed AFTER the cheap provider probe (patterns.ts
    // ordering precedent) and BEFORE any rollup/DB write, matching the
    // no_provider skip: an insufficient-budget run records neither a halt
    // nor a completed round. On a brain where earlier phases eat the whole
    // job budget this fires EVERY cycle — the reason string and operator
    // hint are load-bearing observability, not decoration (a repeated-skip
    // doctor check is a filed follow-up).
    if (resolvedDeadlineMs === null) {
      return {
        summary:
          `propose_takes skipped: remaining cycle budget under ` +
          `${Math.round(MIN_PROPOSE_TAKES_BUDGET_MS / 1000)}s ` +
          `(reserve ${Math.round(CYCLE_DEADLINE_RESERVE_MS / 1000)}s) — earlier phases consumed ` +
          `the job budget; raise the autopilot interval or the autopilot-cycle handler anchor ` +
          `if this repeats every cycle. Next cycle retries with a fresh budget.`,
        details: {
          reason: 'insufficient_cycle_budget',
          // The job deadline is WHY the phase can't start — carry the same
          // flag the mid-run partial exit sets so dashboards see one signal.
          deadline_hit: true,
          pages_scanned: 0,
          cache_hits: 0,
          cache_misses: 0,
          proposals_inserted: 0,
          tombstones_written: 0,
          budget_exhausted: false,
          warnings: [],
        },
        status: 'skipped',
      };
    }
    const deadlineMs = resolvedDeadlineMs;

    const result: ProposeTakesResult = {
      pages_scanned: 0,
      cache_hits: 0,
      cache_misses: 0,
      proposals_inserted: 0,
      tombstones_written: 0,
      budget_exhausted: false,
      llm_calls_succeeded: 0,
      llm_calls_failed: 0,
      warnings: [],
      deadline_hit: false,
    };

    // gbrain#4168: job budget already inside the reserve window — exit
    // cleanly before ANY work (the in-loop `elapsed > deadline` check can't
    // fire on the first iteration when the effective deadline is 0).
    if (deadlineMs <= 0) {
      result.warnings.push('phase skipped: job deadline already inside the reserve window');
      result.deadline_hit = true;
      return {
        summary: `propose_takes: skipped — job deadline inside the reserve window (run ${proposalRunId})`,
        details: { ...result, proposal_run_id: proposalRunId, prompt_version: promptVersion },
        status: 'warn' as PhaseStatus,
      };
    }

    // Load pages eligible for proposal. Source-scoped per BaseCyclePhase.
    const pages = await listCandidatePages(engine, scope, pageLimit);

    if (opts.reporter) {
      opts.reporter.start('propose_takes.pages' as never, pages.length);
    }

    // #3044 — shared halt policy: auth/billing halt on the first hit, a
    // rate_limit streak halts after RATE_LIMIT_HALT_STREAK consecutive
    // failures. A successful call resets the streak.
    const llmHalt = createGlobalLlmHaltTracker();

    for (const page of pages) {
      // Phase deadline check. Break (not throw) so the phase returns a
      // partial result with deadline_hit:true; work already banked stays.
      const elapsedMs = Date.now() - phaseStartMs;
      if (elapsedMs > deadlineMs) {
        result.warnings.push(
          `phase deadline hit at page ${result.pages_scanned}/${pages.length} ` +
          `after ${(elapsedMs / 1000).toFixed(0)}s (cap ${(deadlineMs / 1000).toFixed(0)}s); partial completion`,
        );
        result.deadline_hit = true;
        break;
      }

      result.pages_scanned += 1;
      this.tick(opts);

      // Skip pages that have NO prose body (e.g. metadata-only entity stubs).
      const body = page.compiled_truth ?? '';
      if (body.trim().length === 0) continue;
      if (skipPagesWithFence && hasCompleteFence(body)) continue;

      const ch = contentHash(body);
      const existingTakes = extractExistingTakesForDedup(body);

      // Idempotency check. If a row exists for (source_id, page_slug, content_hash,
      // prompt_version), this page was already processed — skip and count as cache hit.
      const sourceId = page.source_id ?? scope.sourceId ?? 'default';
      const cached = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM take_proposals
         WHERE source_id = $1 AND page_slug = $2 AND content_hash = $3 AND prompt_version = $4
         LIMIT 1`,
        [sourceId, page.slug, ch, promptVersion],
      );
      if (cached.length > 0) {
        result.cache_hits += 1;
        continue;
      }
      result.cache_misses += 1;

      // Budget pre-check before the LLM call. Estimate: ~1500 input tokens + 500 output.
      const budget = this.checkBudget({
        modelId,
        estimatedInputTokens: 1500,
        maxOutputTokens: 500,
      });
      if (!budget.allowed) {
        result.budget_exhausted = true;
        result.warnings.push(
          `budget exhausted at page ${result.pages_scanned}/${pages.length} (cumulative $${budget.cumulativeCostUsd.toFixed(4)} / cap $${budget.budgetUsd.toFixed(2)})`,
        );
        break;
      }

      // Call the extractor. Per-page errors log a warning and continue —
      // UNLESS they classify as a whole-run condition (#3044): auth/billing
      // halts on the first hit (a revoked key or exhausted spend limit fails
      // identically on every remaining page); a bare rate_limit halts only
      // after RATE_LIMIT_HALT_STREAK consecutive hits (a burst 429 can clear
      // between pages).
      let proposals: ProposedTake[];
      try {
        proposals = await extractor({
          pagePath: page.slug,
          pageBody: body,
          existingTakes,
          modelHint: opts.model,
          // #4494: configurable output caps (see resolution above).
          maxTokens: extractorMaxTokens,
          retryMaxTokens: extractorRetryMaxTokens,
        });
      } catch (err) {
        result.llm_calls_failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        const detail = `extractor failed on ${page.slug}: ${msg}`;
        const decision = llmHalt.observe(err);
        if (decision !== 'continue') {
          result.aborted_global_error = haltedClassOf(decision)!;
          result.warnings.push(
            `aborting phase at page ${result.pages_scanned}/${pages.length}: ` +
            `${llmHalt.note()} (${detail})`,
          );
          break;
        }
        result.warnings.push(detail);
        // #3763: N consecutive failures with ZERO successes = dead lane.
        // Halt instead of spending an LLM call on every remaining page. A
        // single success anywhere in the run keeps llm_calls_succeeded > 0
        // and permanently disarms this halt (mixed runs are per-page noise).
        if (
          result.llm_calls_succeeded === 0 &&
          result.llm_calls_failed >= EXTRACTOR_FAILURE_HALT_STREAK
        ) {
          result.aborted_failure_streak = true;
          result.warnings.push(
            `aborting phase at page ${result.pages_scanned}/${pages.length}: ` +
            `${result.llm_calls_failed} consecutive extractor failures with zero successes — ` +
            `halting to avoid re-billing every remaining page (no tombstones written; pages retry next cycle)`,
          );
          break;
        }
        continue;
      }
      result.llm_calls_succeeded += 1;
      llmHalt.reset();

      // Write proposals to take_proposals. #2138: the idempotency key is
      // per-CLAIM — take_proposals_idempotency_idx folds md5(claim_text) into
      // the per-page tuple (migration v125), so a multi-claim page keeps every
      // claim. RETURNING id prevents a repeated claim from inflating the count.
      for (const p of proposals) {
        const inserted = await engine.executeRaw<{ id: number }>(
          `INSERT INTO take_proposals
             (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
              claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12)
           ON CONFLICT (source_id, page_slug, content_hash, prompt_version, md5(claim_text)) DO NOTHING
           RETURNING id`,
          [
            sourceId,
            page.slug,
            ch,
            promptVersion,
            proposalRunId,
            p.claim_text,
            p.kind,
            p.holder,
            p.weight,
            p.domain ?? null,
            JSON.stringify(existingTakes),
            modelId,
          ],
        );
        result.proposals_inserted += inserted.length;
      }

      // Memoize the empty case too. A page that extracted zero claims gets
      // NO row from the loop above, so without this its idempotency tuple is
      // never recorded and the next cycle re-spends an LLM call on unchanged
      // prose (the idle-cost bug). Write one tombstone row keyed by the same
      // per-page tuple (the cache-hit lookup above matches ANY row for the
      // 4-tuple; the unique index — take_proposals_idempotency_idx, migration
      // v125 — folds md5(claim_text) in, so the conflict target must too).
      // status='rejected' keeps it out of any pending-review query; its sole
      // purpose is to make the next cycle a cache hit. Only reached on a
      // SUCCESSFUL empty extract — the extractor-throw path `continue`s above,
      // so failed pages are retried rather than tombstoned.
      if (proposals.length === 0) {
        await engine.executeRaw(
          `INSERT INTO take_proposals
             (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
              claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12, 'rejected')
           ON CONFLICT (source_id, page_slug, content_hash, prompt_version, md5(claim_text)) DO NOTHING`,
          [
            sourceId,
            page.slug,
            ch,
            promptVersion,
            proposalRunId,
            EMPTY_EXTRACTION_TOMBSTONE_TEXT,
            'fact',
            'brain',
            0,
            null,
            JSON.stringify(existingTakes),
            modelId,
          ],
        );
        result.tombstones_written += 1;
      }
    }

    if (opts.reporter) opts.reporter.finish();

    // v0.42 Wave B3: receipt + rollup for propose_takes. Source-scoped
    // via the read scope. Receipt only when proposals actually written.
    const sourceIdForReceipt = scope.sourceId ?? 'default';
    if (result.proposals_inserted > 0) {
      try {
        await writeReceipt(engine, {
          kind: 'takes.proposed',
          source_id: sourceIdForReceipt,
          run_id: proposalRunId,
          round: 'single',
          extracted_at: new Date().toISOString(),
          total_rows: result.proposals_inserted,
          cost_usd: 0, // tracker isn't exposed at this layer; cost tracked centrally
          summary:
            `Proposed ${result.proposals_inserted} new takes from ${result.pages_scanned} pages ` +
            `(${result.cache_hits} cached).`,
        });
      } catch (err) {
        console.error(`[propose_takes] receipt write failed: ${(err as Error).message}`);
      }
    }
    // #4482: three-way stop classification. A budget/deadline cap is the
    // extractor working as designed (partial progress banked; the rest
    // drains over future runs) — recorded as expected_limit_delta, a
    // capacity signal doctor's failure rate excludes. A global-error abort
    // (#3044) or an all-failures streak (#3763) is a REAL halt, unchanged
    // from today. An error alongside a cap counts as the error.
    // `halted` (any incomplete round, caps included) is kept for the phase
    // result's status/details below — the diagnostic split is rollup-only.
    const halted =
      result.budget_exhausted ||
      result.deadline_hit === true ||
      result.aborted_global_error !== undefined ||
      result.aborted_failure_streak === true;
    await upsertExtractRollup(engine, {
      kind: 'takes.proposed',
      source_id: sourceIdForReceipt,
      ...classifyRunStop({
        budget_exhausted: result.budget_exhausted === true,
        deadline_hit: result.deadline_hit === true,
        error:
          result.aborted_global_error !== undefined ||
          result.aborted_failure_streak === true,
      }),
    });

    // Status folds warnings in (the extract_facts precedent from #1928): a
    // run with swallowed per-page failures must not read as a clean 'ok'.
    // Severity split (#3044): a global halt with ZERO successful extractor
    // calls means the whole LLM lane is down — that is a phase 'fail', not a
    // 'warn' (deriveStatus turns one failed phase into a 'partial' cycle;
    // the autopilot handler deliberately does not throw on partial). A halt
    // after some successes is a partial run → 'warn'.
    const warningCount = result.warnings.length;
    // #3763: an all-failures streak halt is the same severity as a
    // zero-success global halt — the whole extractor lane is down.
    const phaseFailed =
      (result.aborted_global_error !== undefined && result.llm_calls_succeeded === 0) ||
      result.aborted_failure_streak === true;
    return {
      summary:
        `propose_takes: scanned ${result.pages_scanned} pages, ${result.cache_hits} cached, ${result.proposals_inserted} new proposals, ${result.tombstones_written} empty (run ${proposalRunId})` +
        (result.aborted_global_error
          ? `; aborted on ${result.aborted_global_error} error after ${result.pages_scanned} page(s)`
          : '') +
        (result.aborted_failure_streak
          ? `; aborted after ${result.llm_calls_failed} consecutive extractor failures (zero successes)`
          : '') +
        (warningCount > 0 ? ` (${warningCount} warning(s))` : ''),
      details: { ...result, halted, proposal_run_id: proposalRunId, prompt_version: promptVersion },
      status: phaseFailed ? 'fail' : halted || warningCount > 0 ? 'warn' : 'ok',
    };
  }
}

/**
 * Public entry point — mirrors the v0.23 `runPhaseSynthesize` shape so the
 * cycle orchestrator in cycle.ts can call it uniformly.
 */
export async function runPhaseProposeTakes(
  ctx: OperationContext,
  opts: ProposeTakesOpts = {},
) {
  return new ProposeTakesPhase().run(ctx, opts);
}

/** Test-only access to the class for subclassing in tests. */
export const __testing = {
  ProposeTakesPhase,
  parseExtractorOutput,
  contentHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
  listCandidatePages,
};
