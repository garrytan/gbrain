/**
 * Synthesize phase (v0.23; #4152 two-stage cascade) — conversation-to-brain
 * pipeline. Cheap-model triage gates frontier-model synthesis:
 *
 *   discoverTranscripts ──► runTriagePass (bounded pool, dream.triage.max_ms
 *     │                     time budget for cache MISSES; hits are free)
 *     │                       ├─ HIT: score!=null && triage_version==current
 *     │                       │       && model matches ──► reuse
 *     │                       ├─ MISS ──► judgeSignificance (utility model,
 *     │                       │   head/middle/tail sample within max_chars)
 *     │                       │   {score 0-1, content_type, segments, entities}
 *     │                       │     reliable ──► putDreamVerdict (upsert)
 *     │                       │     degenerate ──► report only, NEVER cached
 *     │                       └─ budget exhausted ──► deferred (next run continues)
 *     ▼
 *   gate (passesTriageGate — ONE decision for reports/fan-out/retriage):
 *     score >= dream.triage.threshold ──────────────────────► PASS
 *     score in [rescue_floor, threshold) AND content_type in
 *       the buried-signal allowlist AND >= rescue_min_segments
 *       of the judge's segments verify as normalized transcript
 *       substrings (F2 rescue, $0, gate-time only) ──────────► PASS (rescued)
 *     (read-time — retuning threshold or rescue knobs = zero re-judge)
 *     ▼
 *   buildSynthesisPrompt + TRIAGE MAP block ──► one subagent per passing
 *   transcript chunk (max_turns = dream.synthesize.max_turns), drained inline
 *   in a private per-run queue ──► put_page slug collection ──► quote
 *   verify/repair (synthesize-verify.ts, F1b — new pages only) ──► provenance
 *   stamp ──► reverse-write ──► summary index.
 *
 * Hard guarantees:
 *   - Subagent never gets fs-write access. Orchestrator holds the dual-write.
 *   - Allow-list is sourced from `skills/_brain-filing-rules.json` (single
 *     source of truth) and threaded as handler data; PROTECTED_JOB_NAMES
 *     prevents MCP from submitting `subagent` jobs, so the field is trusted.
 *   - Cooldown via `dream.synthesize.last_completion_ts` config key —
 *     written ONLY on success (codex finding #5 deferral: no auto git commit
 *     in v1).
 *   - Idempotency via `dream:synth-v2:<source>:filename:<basename>:<hash16>`
 *     job keys (byte-stable — pinned by test/e2e/dream-synthesize-chunking).
 *   - Edited transcripts produce slugs with content-hash suffix → no overwrite.
 *   - Degenerate triage verdicts (truncated / refusal / unparseable /
 *     score out of [0,1]) are never cached — the next cycle re-judges.
 *
 * NOT in v1:
 *   - git auto-commit / push (deferred to v1.1, codex finding #5).
 *   - Borderline-band mid-tier routing + scheduled reject sample-audit
 *     (manual `gbrain dream retriage --audit-rejects` is the v1 control).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chat as gatewayChat, validateModelId, type ChatResult } from '../ai/gateway.ts';
import { AIConfigError } from '../ai/errors.ts';
import { resolveChatContextTokens } from '../ai/model-resolver.ts';
import { normalizeModelId, splitProviderModelId } from '../model-id.ts';
import { hasAnthropicKey } from '../ai/anthropic-key.ts';
import { basename, join, dirname, isAbsolute, resolve } from 'node:path';
import { parseLlmJson } from '../llm-json.ts';
import type { BrainEngine, DreamVerdict, TriageSegment } from '../engine.ts';
import type { PhaseResult, PhaseError } from '../cycle.ts';
import { DEFAULT_PRIVATE_QUEUE_LEASE_MS, MinionQueue } from '../minions/queue.ts';
import { clampSubagentBudgets, CYCLE_DEADLINE_RESERVE_MS, MIN_PATTERNS_SUBAGENT_BUDGET_MS } from './patterns.ts';
import { isQueueQuotaExceededError } from '../minions/admission.ts';
import { waitForCompletionRenewing, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionJobInput, SubagentHandlerData } from '../minions/types.ts';
import { runSubagentsInline, runDrainRenewalTick, percentile, INLINE_LOCK_MS } from './inline-drain.ts';
import { buildManifestContext, buildLinkManifest, type ManifestContext } from './link-manifest.ts';
import { resolveCycleDate, utcDate } from './cycle-date.ts';
import { throwIfAborted } from '../abort-check.ts';

// Re-exports: the drain was peeled to inline-drain.ts (dream-wave C7), the
// allow-list loader to filing-rules.ts (#2397); patterns.ts and the
// __testing surface import from here unchanged.
export { runSubagentsInline, runDrainRenewalTick };
import { loadAllowedSlugPrefixes } from './filing-rules.ts';
export { loadAllowedSlugPrefixes };
import { discoverTranscripts, DEFAULT_EXCLUDE_PATTERNS, type DiscoveredTranscript } from './transcript-discovery.ts';
import { loadStorageConfig, isDbOnly } from '../storage-config.ts';
import { serializeMarkdown, serializePageToMarkdown } from '../markdown.ts';
import type { Page, PageType } from '../types.ts';
import { validateSourceId } from '../utils.ts';
import { safeSplitIndex } from '../text-safe.ts';
import { PAGE_SLUG_SEG } from '../cjk.ts';
import { withChatPhase, estimateChatCostUsd } from '../ai/chat-usage.ts';
import { verifyAndRepairDreamPages, normForGrounding, type QuoteVerifyStats, type TranscriptForVerify } from './synthesize-verify.ts';
import { passesTriageGate, rescueConfigOf, DEFAULT_RESCUE_FLOOR, DEFAULT_RESCUE_MIN_SEGMENTS, DEFAULT_RESCUE_CONTENT_TYPES, DEFAULT_RESCUE_CONFIG, type RescueConfig, type RescueVerdictLike } from './triage-rescue.ts';

// Slug grammar from validatePageSlug — shared via PAGE_SLUG_SEG (#738).
// Used for the orchestrator-written summary index slug. `u` flag required
// by PAGE_SLUG_SEG's \p{...} classes (#3417).
const SUMMARY_SLUG_RE = new RegExp(`^${PAGE_SLUG_SEG}(\\/${PAGE_SLUG_SEG})*$`, 'u');

// ── Model context budget (D1, D5, D7, D9) ─────────────────────────────

/** Token-to-char ratio. 3.5 matches PR #748; conservative for English text. */
export const CHARS_PER_TOKEN = 3.5;
/** Reserve 10% of context window for system prompt + tool defs + output. */
const HEADROOM_RATIO = 0.9;
/** Floor on user-overridable max_prompt_tokens (matches PR #748 minimum). */
const MIN_PROMPT_TOKENS = 100_000;
/** Default chunk-count cap; operator-configurable via dream.synthesize.max_chunks_per_transcript. */
const DEFAULT_MAX_CHUNKS = 24;
/** Conservative default budget when model is unknown (200K × HEADROOM_RATIO). */
const UNKNOWN_MODEL_BUDGET_TOKENS = 180_000;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = 35 * 60 * 1000;

// ── Triage-v1 constants (#4152) ───────────────────────────────────────

/**
 * Triage prompt-schema version. Bump when the judge prompt or output schema
 * changes in a way that makes old scores incomparable — cached rows with a
 * different version are treated as misses and re-judged (cheap, utility tier).
 *
 * v2 (eval write-path fix wave): peak-not-average scoring clarification +
 * concrete-facts segment-selection nudge. The bump invalidates every cached
 * verdict; the first post-upgrade cycle re-judges the corpus bounded by
 * dream.triage.max_ms (deferred files continue next cycle), and
 * `gbrain dream retriage` is the operator remedy for a full sweep.
 */
export const TRIAGE_VERSION = 2;
/**
 * Fixed constant used ONLY to derive the stored `worth_processing` boolean at
 * write time (back-compat for boolean-era readers). The RUNTIME gate is
 * `score >= dream.triage.threshold`, evaluated at fan-out — never baked into
 * the cache, so retuning the threshold re-gates instantly with zero re-judging.
 */
export const DEFAULT_TRIAGE_THRESHOLD = 0.5;
/** Sample-window default: head 50% / middle 20% / tail 30% within this many chars. */
const DEFAULT_TRIAGE_MAX_CHARS = 24_000;
/** 2048, not 200/1024: segments+entities JSON needs room after any reasoning-token burn. */
const DEFAULT_TRIAGE_MAX_TOKENS = 2048;
/** Wall-clock budget for cache-miss judging per pass; bounds a cold corpus inside the 30-min job clock. */
const DEFAULT_TRIAGE_MAX_MS = 300_000;
const DEFAULT_TRIAGE_CONCURRENCY = 4;
/**
 * Default subagent turn budget. 16 (down from the pre-#4152 hardcoded 30) is
 * a cost/speed policy call: the transcript rides in the initial prompt and the
 * TRIAGE MAP hands the subagent candidate segments, so turns go to targeted
 * search + page writes. Restore via `dream.synthesize.max_turns=30` if written
 * page counts drop; `details.synthesis.avg_turns` telemetry shows cap pressure.
 */
const DEFAULT_MAX_TURNS = 16;

/**
 * Compute per-chunk character budget for the resolved model + config override.
 *
 * Resolution:
 *   - configMaxPromptTokens (already floored at MIN_PROMPT_TOKENS) wins when set.
 *   - Else the official recipe/model resolver's context declaration × HEADROOM_RATIO.
 *   - Else (unqualified custom id / unknown provider / undeclared recipe) UNKNOWN_MODEL_BUDGET_TOKENS, with
 *     a once-per-process stderr warning.
 *
 * D7 scope: this bounds the INITIAL prompt size only. Tool-loop turn-N
 * accumulation is out of scope for v0.30.2 (terminal-error classification
 * catches turn-N blowups; per-turn budget guard is a v0.31+ follow-up).
 */
export function computeChunkCharBudget(
  model: string,
  configMaxPromptTokens: number | null,
): number {
  if (configMaxPromptTokens !== null) {
    return Math.floor(configMaxPromptTokens * CHARS_PER_TOKEN);
  }
  // Bare Claude ids are the one legacy shape resolveModel may still return;
  // all other bare/custom ids remain unknown rather than guessing a provider.
  const split = splitProviderModelId(model);
  const qualified = split.provider
    ? model
    : model.startsWith('claude-')
      ? normalizeModelId(model)
      : null;
  let ctx: number | undefined;
  if (qualified) {
    try {
      ctx = resolveChatContextTokens(qualified);
    } catch (err) {
      if (!(err instanceof AIConfigError)) throw err;
    }
  }
  if (ctx === undefined) {
    warnUnknownModelOnce(model);
    return Math.floor(UNKNOWN_MODEL_BUDGET_TOKENS * CHARS_PER_TOKEN);
  }
  return Math.floor(ctx * HEADROOM_RATIO * CHARS_PER_TOKEN);
}

const _unknownModelWarned = new Set<string>();
function warnUnknownModelOnce(model: string): void {
  if (_unknownModelWarned.has(model)) return;
  _unknownModelWarned.add(model);
  process.stderr.write(
    `[dream] model "${model}" has no declared chat context window; ` +
    `using ${UNKNOWN_MODEL_BUDGET_TOKENS}-token fallback budget. ` +
    `Set dream.synthesize.max_prompt_tokens to override.\n`,
  );
}

// ── Hash-deterministic transcript chunker (D9) ────────────────────────

/**
 * Split content into chunks at most maxChars long, picking boundaries via a
 * 3-tier ladder lifted from PR #748:
 *   1. `## Topic:` separators (matches the daily-aggregated transcript shape)
 *   2. `---` markdown HR markers
 *   3. nearest `\n` newline
 *
 * D9 stable chunk identity: the back-half-of-budget search window is seeded
 * with a deterministic offset derived from contentHash so the same
 * (content, contentHash, maxChars) triple always produces identical chunks.
 * Closes the partial-progress ambiguity: chunk 2 of a transcript that
 * previously failed terminally produces byte-identical content on retry,
 * so the per-chunk idempotency key is durable across runs.
 *
 * The hash-derived offset jitters the search start within
 * [0.5×budget, 0.6×budget] so the back-half rule still holds.
 *
 * If no boundary fits, hard-split at maxChars (also deterministic in the
 * inputs).
 *
 * Pure function. Tested by `test/cycle/synthesize-chunker.test.ts`.
 */
export function splitTranscriptByBudget(
  content: string,
  contentHash: string,
  maxChars: number,
): string[] {
  if (maxChars <= 0) {
    throw new Error(`splitTranscriptByBudget: maxChars must be > 0, got ${maxChars}`);
  }
  if (content.length <= maxChars) return [content];

  const hashInt = parseHashOffset(contentHash);
  // Jitter window is the next 10% of budget after the 50% midpoint.
  const jitterRange = Math.max(1, Math.floor(maxChars * 0.1));
  const searchStart = Math.floor(maxChars * 0.5) + (hashInt % jitterRange);

  const out: string[] = [];
  let remaining = content;
  while (remaining.length > maxChars) {
    const split = findBoundary(remaining, maxChars, searchStart);
    out.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

function parseHashOffset(contentHash: string): number {
  // First 8 hex chars = 32 bits; plenty of entropy for the offset jitter.
  const hex = contentHash.slice(0, 8);
  const n = parseInt(hex, 16);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function findBoundary(text: string, maxChars: number, searchStart: number): number {
  const window = text.slice(searchStart, maxChars);
  // Tier 1: "\n## Topic:" — last occurrence inside the search window.
  const topicIdx = window.lastIndexOf('\n## Topic:');
  if (topicIdx >= 0) return searchStart + topicIdx;
  // Tier 2: "\n---\n" markdown HR.
  const hrIdx = window.lastIndexOf('\n---\n');
  if (hrIdx >= 0) return searchStart + hrIdx;
  // Tier 3: any newline.
  const nlIdx = window.lastIndexOf('\n');
  if (nlIdx >= 0) return searchStart + nlIdx;
  // No boundary fits; hard-split at maxChars (deterministic).
  // v0.42.0.0: route through safeSplitIndex so a hard-split that lands
  // between a UTF-16 surrogate pair (emoji / non-BMP CJK / mathematical
  // alphanumerics) doesn't orphan the high surrogate — that would change
  // chunk byte-content vs the source and break the D9 stable-chunk-identity
  // invariant on the next retry.
  return safeSplitIndex(text, maxChars);
}

/**
 * D6: orchestrator-side deterministic slug rewrite. Zero Sonnet trust.
 *
 * Expected shape from `buildSynthesisPrompt` for a chunked child is already
 * `<base>-<hash6>-c<idx>`, but if Sonnet drops the chunk suffix this rewrite
 * enforces uniqueness post-hoc. Same hash AND same chunk idx → idempotent.
 *
 * Pure function. Cases:
 *   - already correctly suffixed (`...-<hash6>-c<idx>`) → return unchanged.
 *   - bare hash suffix (`...-<hash6>`) → append `-c<idx>`.
 *   - some other shape → pass through (orchestrator can't safely guess
 *     where to inject the chunk index; e2e test pins this).
 */
export function rewriteChunkedSlug(slug: string, hash6: string, idx: number): string {
  if (!slug) return slug;
  const expected = `${hash6}-c${idx}`;
  // Already correctly chunk-suffixed.
  if (slug === expected) return slug;
  if (slug.endsWith(`-${expected}`) || slug.endsWith(`/${expected}`)) return slug;
  // Bare hash6 at end of last path segment: rewrite.
  // Match either at start-of-slug, after a "/" path separator, or after a "-".
  const re = new RegExp(`(^|[/-])${hash6}$`);
  if (re.test(slug)) return `${slug}-c${idx}`;
  // Unknown shape — pass through; collision risk is now bounded by Sonnet's
  // per-chunk-prompt guidance and the existing slug-prefix allow-list.
  return slug;
}

// ── Public entry ──────────────────────────────────────────────────────

export interface SynthesizePhaseOpts {
  brainDir: string;
  dryRun: boolean;
  /** #4077: cooperative cancellation from the enclosing cycle/minion job. A
   *  cancelled cycle must stop judge calls, inline children, and every
   *  derived-state write instead of running out the force-evict grace. */
  signal?: AbortSignal;
  /** Generic in-cycle keepalive for cycle-lock TTL renewal during long waits. */
  yieldDuringPhase?: () => Promise<void>;
  /**
   * Override the corpus directory and other tunables. Primarily for the
   * `gbrain dream --input <file>` ad-hoc path; bypasses config reads.
   */
  inputFile?: string;
  date?: string;
  from?: string;
  to?: string;
  /** #4348: clock seam for deterministic cycle-date bucketing (tests). */
  now?: () => Date;
  /** #4168 sibling: absolute wall-clock deadline (epoch ms) of the enclosing
   *  minion job. When set, child-subagent timeout_ms/wait are clamped via the
   *  clampSubagentBudgets template so a child submitted late in the cycle
   *  cannot outlive the parent's kill switch; under the minimum budget the
   *  phase skips honestly instead of submitting a guaranteed-timeout child.
   *  Null/unset (`gbrain dream` CLI) keeps the configured defaults. */
  deadlineAtMs?: number | null;
  /**
   * Disable the self-consumption guard. Wired from the
   * `--unsafe-bypass-dream-guard` CLI flag. NOT auto-applied for `--input`
   * because that would allow any dream-generated page to silently re-enter
   * the synthesize loop. Caller must opt in explicitly.
   */
  bypassDreamGuard?: boolean;
  /**
   * #1586: the cycle's resolved brain source (cycleSourceId from cycle.ts —
   * explicit --source wins, else derived from the checkout dir). Threaded to
   * every subagent child as `source_id` so put_page writes land in this
   * source, and stamped onto collected refs so reverse-writes read the
   * correct (source_id, slug) row. Unset → legacy 'default'.
   */
  sourceId?: string;
  /** Internal: minion owner job id for private dream-inline queue recovery. */
  privateQueueOwnerJobId?: number | null;
  /**
   * issue #2860 — `gbrain dream --phase synthesize --once`. Bypasses the
   * `dream.synthesize.enabled` gate for THIS call only (does NOT bypass
   * the `session_corpus_dir` not-configured check — there's nothing to
   * run without a corpus). Never reads or writes config.
   */
  once?: boolean;
}

export async function runPhaseSynthesize(
  engine: BrainEngine,
  opts: SynthesizePhaseOpts,
): Promise<PhaseResult> {
  // F6 spend attribution: triage-judge + orchestrator gateway calls inside
  // this phase land in chat_usage_log as phase:synthesize. Child subagent
  // calls keep their own job:* tag — the innermost AsyncLocalStorage phase
  // wins (minions/worker.ts wraps each job), and that is intentional: the
  // authoritative child spend rolls up from minion_jobs token columns below.
  return withChatPhase('phase:synthesize', () => runPhaseSynthesizeInner(engine, opts));
}

async function runPhaseSynthesizeInner(
  engine: BrainEngine,
  opts: SynthesizePhaseOpts,
): Promise<PhaseResult> {
  const start = Date.now();
  let ownedPrivateQueue: { queue: MinionQueue; name: string } | null = null;
  // Normalize brainDir to an absolute path BEFORE any reverse-write. Without
  // this, a relative or empty brainDir flows down to writeReversePages →
  // `join(brainDir, '${slug}.md')` → relative path → resolves against cwd at
  // writeFileSync time, spilling synthesize output into whatever directory
  // the cycle ran from (e.g., `companies/novamind.md` at the repo root).
  // Surfaced by the warm-narwhal wave when E2E test cleanup found orphan
  // synthesize pages at repo root from a `runCycle({brainDir: '.'})` call
  // chain. Throw on empty (silent cwd-resolution is worse than a loud
  // failure); resolve if relative (`.` / `./brain` / `../sibling` all valid
  // inputs but must canonicalize before the write).
  if (!opts.brainDir || opts.brainDir.trim() === '') {
    return failed(makeError('InternalError', 'BRAINDIR_EMPTY',
      'opts.brainDir is empty; refusing to run synthesize. Pass an absolute path.'));
  }
  if (!isAbsolute(opts.brainDir)) {
    opts.brainDir = resolve(opts.brainDir);
  }
  try {
    throwIfAborted(opts.signal, '[dream] synthesize');
    const config = await loadSynthConfig(engine);
    // #4348: the calendar day that owns this run — explicit --date >
    // cycle.timezone config > host IANA timezone > UTC. Sampled ONCE at
    // phase start so a run that crosses midnight stays in one bucket.
    // Pre-fix this was UTC toISOString().slice(0,10), so a run after local
    // midnight but before UTC midnight rewrote the previous day's summary.
    const summaryDate = await resolveCycleDate(engine, { explicitDate: opts.date, now: opts.now });

    // #4168 sibling: clamp the child-subagent budgets to the REAL remaining
    // job time (patterns.ts clampSubagentBudgets template). Pre-fix,
    // DEFAULT_SUBAGENT_TIMEOUT_MS (30min) was submitted raw as the child's
    // timeout_ms even when the parent cycle had two minutes left — the same
    // deadline-equals-kill-switch collision propose_takes had, one process
    // boundary further out.
    const clamped = clampSubagentBudgets(
      { subagentTimeoutMs: config.subagentTimeoutMs, subagentWaitTimeoutMs: config.subagentWaitTimeoutMs },
      opts.deadlineAtMs,
      Date.now(),
    );
    if (clamped === null) {
      return skipped('insufficient_cycle_budget',
        'remaining cycle budget too small to submit a synthesize child that could finish; next cycle retries with a fresh budget');
    }
    config.subagentTimeoutMs = clamped.timeoutMs;
    config.subagentWaitTimeoutMs = clamped.waitTimeoutMs;

    // Allow ad-hoc --input to run even when config is disabled.
    if (!opts.inputFile && !config.corpusDir) {
      return skipped('not_configured',
        'dream.synthesize.session_corpus_dir is unset');
    }
    if (!opts.inputFile && !config.enabled) {
      if (!opts.once) {
        return skipped('not_configured',
          'dream.synthesize.enabled is explicitly false');
      }
      process.stderr.write(
        '[dream] --once: dream.synthesize.enabled is false but ' +
        '--phase synthesize --once forces this run (config untouched)\n',
      );
    }

    // Cooldown check (skipped for explicit --input / --date / --from / --to runs).
    const explicitTarget = opts.inputFile || opts.date || opts.from || opts.to;
    if (!explicitTarget) {
      const cooldown = await checkCooldown(engine, config.cooldownHours);
      if (cooldown.active) {
        return skipped('cooldown_active',
          `synthesize cooled down until ${cooldown.expires_at} (${config.cooldownHours}h cooldown)`);
      }
    }

    if (opts.bypassDreamGuard) {
      process.stderr.write(
        '[dream] WARNING: --unsafe-bypass-dream-guard set; self-consumption guard disabled. ' +
        'Re-ingestion of dream output will incur Sonnet costs forever.\n',
      );
    }

    // v0.32.6 M2: pre-fetch prior contradictions from the most recent probe
    // run (if any). Surfaced as an informational block to the synthesize
    // subagent so it knows which slugs it should reconcile if it writes to
    // them. Best-effort — a probe that's never run is a normal early state.
    const priorContradictionsBlock = await loadPriorContradictionsBlock(engine);

    // Discover.
    const transcripts = opts.inputFile
      ? loadAdHocTranscript(opts.inputFile, config.minChars, config.excludePatterns, opts.bypassDreamGuard)
      : discoverTranscripts({
          corpusDir: config.corpusDir!,
          meetingTranscriptsDir: config.meetingTranscriptsDir ?? undefined,
          minChars: config.minChars,
          excludePatterns: config.excludePatterns,
          date: opts.date,
          from: opts.from,
          to: opts.to,
          bypassGuard: opts.bypassDreamGuard,
        });

    if (transcripts.length === 0) {
      return ok('no transcripts to process', { transcripts_processed: 0, pages_written: 0 });
    }

    // Best-effort housekeeping (#4069): expiry is enforced on reads
    // regardless, so a sweep failure must not block synthesis when the
    // database is otherwise usable.
    try {
      const swept = await engine.sweepDreamVerdicts();
      if (swept > 0) process.stderr.write(`[dream] swept ${swept} expired verdict cache row(s)\n`);
    } catch (e) {
      process.stderr.write(`[dream] warning: verdict cache sweep failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }

    // Scored triage (#4152): cached in dream_verdicts, judged on miss by the
    // utility-tier model through a bounded pool with a wall-clock miss budget.
    // Provider-aware judge client routes through gateway.chat, so any
    // configured provider works (Anthropic, DeepSeek, OpenRouter, Voyage,
    // Ollama, llama-server, etc.); an unreachable provider degrades
    // per-transcript inside the pass.
    const pass = await runTriagePass(engine, transcripts, {
      model: config.triage.model,
      maxChars: config.triage.maxChars,
      maxTokens: config.triage.maxTokens,
      threshold: config.triage.threshold,
      concurrency: config.triage.concurrency,
      maxMs: config.triage.maxMs,
      signal: opts.signal,
      rescue: rescueConfigOf(config.triage),
    }, opts.yieldDuringPhase);
    const verdicts = pass.reports;

    // Read-time gate: retuning dream.triage.threshold (or the rescue knobs)
    // re-gates instantly with zero re-judging — scores + segments persist in
    // dream_verdicts; the dial is applied at report construction inside
    // runTriagePass (F2: `worth` = threshold pass OR verified-segment rescue,
    // ONE decision for the fan-out, telemetry, dry-run, and retriage).
    const reportByPath = new Map(pass.reports.map(r => [r.filePath, r]));
    const worthProcessing = transcripts.filter(t => reportByPath.get(t.filePath)?.worth === true);

    // Count semantics (outside-voice CX7): below_threshold counts ONLY files
    // with a real score under the gate; degraded = no usable score and not
    // deferred/unreliable (no reachable provider, mid-run gateway error). A
    // provider outage must never read as mass rejection.
    const degradedCount = pass.reports.filter(
      r => r.score === null && !r.deferred && !r.unreliable,
    ).length;
    const triageDetails = {
      threshold: config.triage.threshold,
      judged: pass.judged,
      cache_hits: pass.cacheHits,
      unreliable: pass.unreliable,
      deferred: pass.deferred,
      degraded: degradedCount,
      below_threshold: pass.reports.filter(r => r.score !== null && !r.worth).length,
      // F6 spend visibility: judge-call tokens for this pass's cache MISSES
      // (hits are free); cost estimate from canonical pricing, null when the
      // triage model has no canonical price — never a fake 0.
      tokens_in: pass.tokens.in,
      tokens_out: pass.tokens.out,
      cost_usd: priceChatUsd(config.triage.model, { in: pass.tokens.in, out: pass.tokens.out }),
      // F2 rescue observability: checked = reports whose score landed in the
      // band (rescue evaluated); fired = passes that came from the rescue.
      rescue_band: [config.triage.rescueFloor, config.triage.threshold],
      rescue_checked: pass.reports.filter(
        r => r.score !== null && r.score < config.triage.threshold && r.score >= config.triage.rescueFloor,
      ).length,
      rescue_fired: pass.reports.filter(r => r.rescued === true).length,
    };
    // 3A: a time-boxed cold pass must never read as mass rejection.
    const deferralSuffix = pass.deferred > 0
      ? ` (${pass.deferred} not yet triaged — time budget; re-run or use dream retriage)`
      : '';

    // Dry-run stops here: the triage pass ran (scores cached), but no
    // synthesis. Codex finding #8: --dry-run does NOT mean "zero LLM calls";
    // it means "skip the synthesis model."
    if (opts.dryRun) {
      return ok(`dry-run: ${worthProcessing.length} of ${transcripts.length} transcripts would synthesize${deferralSuffix}`, {
        transcripts_discovered: transcripts.length,
        transcripts_processed: 0,
        pages_written: 0,
        verdicts,
        triage: triageDetails,
        dryRun: true,
      });
    }

    if (worthProcessing.length === 0) {
      // Even with verdicts, the cooldown timestamp is updated only on a
      // real successful run — not on "nothing worth processing." Lets a
      // re-run pick up if a new transcript lands later.
      // Honest zero-pass headline: an all-degraded run (provider outage) is
      // NOT "everything was below threshold" (outside-voice CX7).
      const zeroPassMsg = triageDetails.below_threshold > 0
        ? `all transcripts below triage threshold (${triageDetails.below_threshold} below, ${triageDetails.degraded + pass.unreliable} degraded)${deferralSuffix}`
        : degradedCount + pass.unreliable > 0
          ? `triage degraded: no usable verdicts (${degradedCount + pass.unreliable} degraded/unreliable — check the triage provider)${deferralSuffix}`
          : `no transcripts passed triage${deferralSuffix}`;
      return ok(zeroPassMsg, {
        transcripts_discovered: transcripts.length,
        transcripts_processed: 0,
        pages_written: 0,
        verdicts,
        triage: triageDetails,
      });
    }

    // Fan-out: submit one subagent per worth-processing transcript (or one
    // per chunk for transcripts that exceed the model's per-prompt budget).
    // #4117: the validated per-lane namespaces derive extra allow-list globs
    // so a custom reflections/originals prefix is actually writable.
    const allowedSlugPrefixes = await loadAllowedSlugPrefixes(config.outputRoot, engine, {
      reflectionsPrefix: config.reflectionsPrefix,
      originalsPrefix: config.originalsPrefix,
    });
    if (allowedSlugPrefixes.length === 0) {
      return failed(makeError('InternalError', 'NO_ALLOWLIST',
        'skills/_brain-filing-rules.json missing dream_synthesize_paths.globs'));
    }

    // #4216: pre-retrieval manifest context — one slug snapshot + basename
    // index per phase, reused across every transcript's LINK CANDIDATES
    // block. Scoped to the cycle's write source so manifest reads see the
    // same universe the oneshot validator probes. Best-effort: a failure
    // here degrades to the manifest-less prompt.
    const cycleSourceId = opts.sourceId ?? 'default';
    let manifestCtx: ManifestContext | null = null;
    if (config.linkManifest) {
      try {
        manifestCtx = await buildManifestContext(engine, cycleSourceId);
      } catch (e) {
        process.stderr.write(`[dream] manifest context build failed (continuing without manifests): ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    const queue = new MinionQueue(engine);
    // #2050: children drain inline on BOTH engines (see runSubagentsInline),
    // so give them a private per-run queue: the inline drain must never claim
    // unrelated 'default'-queue jobs, and a 'default'-queue worker must never
    // claim a child this parent is about to run itself.
    const childQueueName = `dream-inline-${Date.now()}-${randomUUID().slice(0, 8)}`;
    ownedPrivateQueue = { queue, name: childQueueName };
    const privateQueueOwnerToken = randomUUID();
    // Rolling 10-min lease renewed every ≤30s from the drain loop (idle polls,
    // claim iterations, per-child keepalive) and the post-drain chunked wait —
    // a crashed run's queue becomes lease-recoverable within ~10 minutes
    // instead of a wait-timeout-sized horizon. The whole wrapper (lease AND
    // cycle-lock refresh) is 30s-throttled so 1-5s polls cost one UPDATE per
    // half-minute, not per poll; the cycle lock's 5-min TTL is ample at 30s.
    const renewPrivateQueueLease = queue.makeThrottledLeaseRenewer(
      childQueueName, privateQueueOwnerToken, opts.yieldDuringPhase,
    );
    const childIds: number[] = [];
    /** Map child job_id → chunk metadata for D6 orchestrator-side slug rewrite. */
    const chunkInfo = new Map<number, { idx: number; hash6: string }>();
    /** #1978: map child job_id → source transcript path so written pages get a raw_source stamp. */
    const jobRawSource = new Map<number, string>();
    /** Skip reasons for the cycle report (D5 cap hits, D8 legacy-key skips). */
    const skipReports: Array<{ filePath: string; reason: string }> = [];

    const maxCharsPerChunk = computeChunkCharBudget(config.model, config.maxPromptTokens);
    const successfulLegacyKeys = await loadSuccessfulLegacySynthesisKeys(
      engine,
      cycleSourceId,
    );

    // Per-source daily submission cap (D2D: default 0 = disabled; opt-in
    // backstop via dream.synthesize.max_submissions_per_source_per_day).
    // Bypassed for explicit --input/--date/--from/--to runs, same rule as the
    // cooldown. Fail-open: if the count query throws (pool reap mid-phase),
    // warn and skip the cap for this run — backstop availability must never
    // cost phase availability (db-pacer posture).
    const dailyCap = config.maxSubmissionsPerSourcePerDay;
    let capActive = dailyCap > 0 && !explicitTarget;
    let submittedToday = 0;
    if (capActive) {
      try {
        submittedToday = await countRecentSynthSubmissions(engine, cycleSourceId);
      } catch (e) {
        capActive = false;
        process.stderr.write(
          `[dream] daily-cap count query failed (${e instanceof Error ? e.message : String(e)}); ` +
          `skipping the cap for this run\n`,
        );
      }
    }

    // Admission-quota latch: once a submit is rejected, every later transcript
    // this run would be rejected too — record one skip per remaining file
    // without hammering the queue.
    let quotaHit = false;
    // #4168 red-team: transcripts deferred because the parent job budget ran
    // out mid-fan-out (distinct from the quota latch: deferral is budget-time,
    // quota is admission-space; both stop further submits this run).
    const budgetExhaustedDeferrals: string[] = [];
    for (const t of worthProcessing) {
      // #4077: never submit new children after cancellation; the finally's
      // reconcilePrivateQueue cancels anything already submitted.
      throwIfAborted(opts.signal, '[dream] synthesize fan-out');
      if (quotaHit) {
        skipReports.push({ filePath: t.filePath, reason: 'admission_quota: submission stopped this run' });
        continue;
      }
      if (budgetExhaustedDeferrals.length > 0) {
        budgetExhaustedDeferrals.push(basename(t.filePath));
        continue; // budget gone — defer the rest, don't submit more children
      }
      const hash16 = t.contentHash.slice(0, 16);
      const hash6 = t.contentHash.slice(0, 6);

      // D8: legacy-key migration safety. If this content hash already
      // completed under the pre-v2 path-based key family — single-chunk OR
      // a full chunked set — treat as already-synthesized and skip.
      // Prevents a full paid re-synthesis when the corpus root moves or
      // the chunking outcome changes across versions.
      const legacyCompletion = findLegacyCompletion(
        successfulLegacyKeys,
        t.filePath,
        hash16,
      );
      if (legacyCompletion) {
        skipReports.push({
          filePath: t.filePath,
          reason: legacyCompletion === 'chunked'
            ? 'already_synthesized_legacy_chunked'
            : 'already_synthesized_legacy_single_chunk',
        });
        continue;
      }

      const chunks = splitTranscriptByBudget(t.content, t.contentHash, maxCharsPerChunk);

      // D5 cap hit: log + skip; do NOT write to dream_verdicts. Closes the
      // poison-pill class — next cycle re-attempts under whatever budget
      // is then current.
      if (chunks.length > config.maxChunksPerTranscript) {
        process.stderr.write(
          `[dream] transcript ${t.basename} produced ${chunks.length} chunks at ` +
          `${maxCharsPerChunk}-char budget (cap=${config.maxChunksPerTranscript}); skipping. ` +
          `Increase dream.synthesize.max_chunks_per_transcript or use a larger-context model.\n`,
        );
        skipReports.push({
          filePath: t.filePath,
          reason: `oversize_after_split: ${chunks.length}/${config.maxChunksPerTranscript}`,
        });
        continue;
      }

      // Daily cap: skip the WHOLE file when its chunk set would cross the cap
      // — never submit a partial chunk set. Idempotency keys make the retry
      // free on a later cycle. Structured-review P2: the cap bounds NEW
      // spend, not re-submission — a file whose keys already exist (a prior
      // capped-out run died mid-drain) coalesces/self-heals at zero new cost
      // and must not be stranded for the rest of the 24h window.
      if (capActive && submittedToday + chunks.length > dailyCap) {
        const fileKeys = chunks.length > 1
          ? chunks.map((_, i) =>
              `dream:synth-v2:${encodeURIComponent(opts.sourceId ?? 'default')}` +
              `:filename:${encodeURIComponent(basename(t.filePath))}:${hash16}:c${i}of${chunks.length}`)
          : [`dream:synth-v2:${encodeURIComponent(opts.sourceId ?? 'default')}` +
              `:filename:${encodeURIComponent(basename(t.filePath))}:${hash16}`];
        let existingKeys = 0;
        try {
          // Only COALESCIBLE rows count as "already exists": queue.add clears
          // the keys of cancelled/dead rows and inserts fresh PAID jobs, so
          // those must not be credited as zero-cost (structured-review r2 P2).
          const rows = await engine.executeRaw<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM minion_jobs
              WHERE idempotency_key = ANY($1::text[])
                AND status NOT IN ('cancelled', 'dead')`,
            [fileKeys],
          );
          existingKeys = rows[0]?.n ?? 0;
        } catch { /* fail-open like the cap count itself: treat as no existing keys */ }
        const newKeysNeeded = chunks.length - existingKeys;
        if (newKeysNeeded > 0 && submittedToday + newKeysNeeded > dailyCap) {
          skipReports.push({
            filePath: t.filePath,
            reason: `daily_cap_reached: ${submittedToday}/${dailyCap}`,
          });
          continue;
        }
      }

      const isChunked = chunks.length > 1;
      // queue.add subagent validator (classifyCapabilities → resolveRecipe)
      // requires `provider:model`. resolveModel can return a bare id when
      // TIER_DEFAULTS / DEFAULT_ALIASES carry a bare value; ensure the
      // anthropic: prefix is present for known claude-* ids before passing
      // to the queue. Non-anthropic providers must already declare a colon.
      const subagentModel = config.model.includes(':')
        ? config.model
        : config.model.toLowerCase().startsWith('claude-')
          ? `anthropic:${config.model}`
          : config.model;
      const triageVerdict = pass.byPath.get(t.filePath);
      // #4216: per-transcript LINK CANDIDATES manifest (zero-embed; entities/
      // segment notes come from the cached triage verdict).
      let manifestBlock = '';
      if (manifestCtx) {
        const manifest = await buildLinkManifest(
          engine, manifestCtx, triageVerdict, t.basename,
          { outputRoot: config.outputRoot, sourceId: cycleSourceId },
        );
        manifestBlock = manifest.block;
      }
      // Fresh (non-coalesced) chunk submissions for THIS transcript — rolled
      // back if a later chunk hits the admission quota, so a transcript never
      // half-synthesizes while its skip report claims it was skipped
      // (adversarial finding). Coalesced rows are another run's bookkeeping
      // and must not be cancelled.
      const transcriptFreshIds: number[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const childData: SubagentHandlerData = {
          prompt: buildSynthesisPrompt(
            t, chunks[i], i, chunks.length, priorContradictionsBlock, config.outputRoot,
            buildTriageMapBlock(triageVerdict, chunks[i], chunks.length),
            manifestBlock,
            allowedSlugPrefixes,
            // #4117: validated per-lane namespaces.
            config.reflectionsPrefix,
            config.originalsPrefix,
          ),
          model: subagentModel,
          max_turns: config.maxTurns,
          allowed_slug_prefixes: allowedSlugPrefixes,
          // #4216: execution mode + the structural slug-suffix contract
          // (CDX-9) + #4217 write requirement — a synthesis child whose every
          // write failed must dead-letter, not report completed.
          mode: config.mode,
          oneshot_slug_suffix: chunks.length > 1
            ? `${t.contentHash.slice(0, 6)}-c${i}`
            : t.contentHash.slice(0, 6),
          require_writes: true,
          // #1586: scope every child tool call to the cycle's resolved source
          // so put_page writes land there instead of the hardcoded 'default'.
          ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
        };
        // Keep producer identity stable when the corpus root moves. Source and
        // complete filename remain explicit so equal bytes in different source
        // or filename namespaces do not collide.
        const synthesisKey =
          `dream:synth-v2:${encodeURIComponent(opts.sourceId ?? 'default')}` +
          `:filename:${encodeURIComponent(basename(t.filePath))}:${hash16}`;
        const idempotency_key = isChunked
          ? `${synthesisKey}:c${i}of${chunks.length}`
          : synthesisKey;
        // #4168 red-team: the phase is a FAN-OUT and children drain
        // sequentially with claim-time-anchored kill switches, so a single
        // phase-start clamp only bounds the FIRST child. Re-clamp against the
        // live clock per submit; when the remaining parent budget drops under
        // the minimum, stop submitting — deferred transcripts retry next
        // cycle (partial > guaranteed-timeout children).
        const perChild = clampSubagentBudgets(
          { subagentTimeoutMs: config.subagentTimeoutMs, subagentWaitTimeoutMs: config.subagentWaitTimeoutMs },
          opts.deadlineAtMs,
          Date.now(),
        );
        if (perChild === null) {
          budgetExhaustedDeferrals.push(basename(t.filePath));
          break;
        }
        const submitOpts: Partial<MinionJobInput> = {
          max_stalled: 3,
          on_child_fail: 'continue',
          idempotency_key,
          timeout_ms: perChild.timeoutMs,
          queue: childQueueName,
          private_queue_owner_job_id: opts.privateQueueOwnerJobId ?? null,
          private_queue_owner_token: privateQueueOwnerToken,
          private_queue_lease_ms: DEFAULT_PRIVATE_QUEUE_LEASE_MS,
        };
        let child: Awaited<ReturnType<typeof queue.add>>;
        try {
          child = await queue.add(
            'subagent',
            childData as unknown as Record<string, unknown>,
            submitOpts,
            { allowProtectedSubmit: true },
          );
        } catch (e) {
          // Admission quota (minions.quota_max_waiting.subagent, config-only):
          // a rejected submit is a recorded phase skip, never a phase crash —
          // same posture as daily_cap_reached. The quota won't clear mid-run,
          // so stop submitting for this run entirely. Roll back this
          // transcript's already-submitted fresh chunks first: draining a
          // partial chunk set would write partial pages for a transcript the
          // skip report says was skipped.
          if (isQueueQuotaExceededError(e)) {
            for (const id of transcriptFreshIds) {
              try { await queue.cancelJob(id); } catch { /* best-effort rollback */ }
              const idx = childIds.indexOf(id);
              if (idx >= 0) childIds.splice(idx, 1);
              jobRawSource.delete(id);
              chunkInfo.delete(id);
            }
            skipReports.push({ filePath: t.filePath, reason: `admission_quota: ${e.message}` });
            quotaHit = true;
            break;
          }
          throw e;
        }
        // Self-heal (#4152 C1): an idempotency-coalesced row still `waiting`
        // in a FOREIGN dream-inline-* queue was stranded by a previously
        // killed/timed-out run — no worker will ever claim it, and waiting on
        // it burns the full subagentWaitTimeoutMs. Cancel (releases the key
        // slot per queue.add's dead/cancelled rule) and re-add into THIS
        // run's live queue. CX1 guard: only queues older than the liveness
        // grace are provably dead — a young foreign queue may belong to a
        // concurrently running cycle whose drain will claim the row.
        const foreignQueueAge = child.coalesced === true
          && child.status === 'waiting'
          && typeof child.queue === 'string'
          && child.queue !== childQueueName
          ? dreamInlineQueueAgeMs(child.queue)
          : null;
        if (foreignQueueAge !== null && foreignQueueAge > DREAM_INLINE_LIVE_GRACE_MS) {
          const cancelled = await queue.cancelJob(child.id);
          if (cancelled) {
            child = await queue.add(
              'subagent',
              childData as unknown as Record<string, unknown>,
              submitOpts,
              { allowProtectedSubmit: true },
            );
          }
        }
        if (child.coalesced !== true) {
          submittedToday++;
          transcriptFreshIds.push(child.id);
        }
        childIds.push(child.id);
        jobRawSource.set(child.id, t.filePath);
        if (isChunked) {
          chunkInfo.set(child.id, { idx: i, hash6 });
        }
      }
    }

    // CX8: nothing was submitted (every passing file skipped — daily cap,
    // legacy completion, or chunk-cap). Return WITHOUT stamping the cooldown:
    // a run that did no synthesis must not suppress the retry window that
    // would pick these files up.
    if (childIds.length === 0) {
      return ok(`no synthesis submitted (${skipReports.length} passing file(s) skipped)${deferralSuffix}`, {
        transcripts_discovered: transcripts.length,
        transcripts_processed: 0,
        pages_written: 0,
        children_submitted: 0,
        skips: skipReports,
        verdicts,
        triage: triageDetails,
      });
    }

    // Drain this phase's private child queue inline so the parent observes
    // terminal child states instead of polling waiters until
    // subagentWaitTimeoutMs expires. Runs on BOTH engines — on Postgres the
    // parent job otherwise deadlocks a fully-occupied worker (#2050).
    // #4194: bounded concurrency on Postgres; PGLite is FORCED serial (the
    // embedded engine is single-process/exclusive — concurrent loops would
    // contend on one WASM instance for zero gain).
    let effectiveConcurrency = Math.min(config.inlineConcurrency, childIds.length);
    if (engine.kind === 'pglite' && effectiveConcurrency > 1) {
      process.stderr.write(
        `[dream] dream.synthesize.inline_concurrency=${config.inlineConcurrency} ignored on PGLite (exclusive engine); draining serially.\n`,
      );
      effectiveConcurrency = 1;
    }
    const drainStartedAt = Date.now();
    await runSubagentsInline(
      engine, queue, childQueueName, renewPrivateQueueLease,
      undefined, undefined, effectiveConcurrency, opts.deadlineAtMs ?? null,
      opts.signal ?? null,
    );
    // Captured HERE: everything after this line (waiters, collection,
    // provenance, reverse-writes, backfill) is post-drain phase work and must
    // not inflate the #4194 drain observability number.
    const drainMs = Date.now() - drainStartedAt;

    // #4168 adversarial: children the deadline-gated drain never claimed
    // would strand in this per-run private queue forever (no worker claims
    // it). Cancel them and defer their transcripts to the next cycle.
    if (opts.deadlineAtMs != null) {
      const stillWaiting = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM minion_jobs WHERE queue = $1 AND status IN ('waiting', 'delayed')`,
        [childQueueName],
      );
      for (const row of stillWaiting) {
        const cancelled = await queue.cancelJob(row.id);
        if (cancelled) {
          const src = jobRawSource.get(row.id);
          if (src) budgetExhaustedDeferrals.push(basename(src));
        }
      }
    }

    // Wait for every child to reach a terminal state. Tick yieldDuringPhase
    // every 5 min so the cycle lock TTL refreshes.
    const childOutcomes: Array<{ jobId: number; status: string; turns?: number; synth_mode_used?: string; fallback_reason?: string }> = [];
    for (const jobId of childIds) {
      try {
        // #4168 red-team: bound each wait by the REMAINING parent budget
        // (never negative-or-zero — floor at 1s so the fast path still
        // observes an already-terminal child), not just the per-child config.
        const remainingParentMs = opts.deadlineAtMs != null
          ? Math.max(1000, opts.deadlineAtMs - CYCLE_DEADLINE_RESERVE_MS - Date.now())
          : config.subagentWaitTimeoutMs;
        const job = await waitForCompletionRenewing(queue, jobId, {
          timeoutMs: Math.min(config.subagentWaitTimeoutMs, remainingParentMs),
          pollMs: 5 * 1000,
          renew: renewPrivateQueueLease,
          signal: opts.signal,
        });
        // #4077: on abort the wait returns its last snapshot instead of
        // throwing — unwind before recording a non-terminal status as an
        // outcome (finally cancels the still-live children).
        throwIfAborted(opts.signal, '[dream] synthesize completion wait');
        // Turn telemetry: surfaces max_turns cap pressure in details.synthesis
        // so the 30→16 default can be re-litigated on data. #4216 adds the
        // execution-path markers so operators see oneshot vs fallback mix.
        const jr = job.result as { turns_count?: unknown; synth_mode_used?: unknown; fallback_reason?: unknown } | null | undefined;
        const turns = jr?.turns_count;
        childOutcomes.push({
          jobId,
          status: job.status,
          ...(typeof turns === 'number' && Number.isFinite(turns) ? { turns } : {}),
          ...(typeof jr?.synth_mode_used === 'string' ? { synth_mode_used: jr.synth_mode_used } : {}),
          ...(typeof jr?.fallback_reason === 'string' ? { fallback_reason: jr.fallback_reason } : {}),
        });
      } catch (e) {
        if (e instanceof TimeoutError) {
          childOutcomes.push({ jobId, status: 'timeout' });
        } else {
          throw e;
        }
      }
      // After each child terminal, give the cycle lock + worker job lock a chance.
      if (opts.yieldDuringPhase) {
        try { await opts.yieldDuringPhase(); } catch { /* best-effort */ }
      }
    }

    // Collect slugs from put_page tool executions across the children
    // (codex finding #2: deterministic provenance, NOT pages.updated_at).
    // D6 orchestrator slug rewrite: chunkInfo drives post-hoc rewrite of
    // bare-hash slugs to `<hash6>-c<idx>` so chunked siblings can't collide
    // even if Sonnet drops the chunk suffix.
    // v0.32.8: refs carry source_id so reverseWriteRefs picks the correct
    // (source, slug) row. #1586: refs are stamped with the cycle's resolved
    // source (children write there via SubagentHandlerData.source_id;
    // cycleSourceId is hoisted above the fan-out for the daily cap).
    // F6 rule-D visibility: track which children actually wrote pages, so a
    // rescued/passed transcript whose child declined to write (task D) is
    // distinguishable from a triage miss in the phase telemetry.
    const jobsWithPages = new Set<number>();
    const writtenRefs = await collectChildPutPageSlugs(engine, childIds, chunkInfo, cycleSourceId, jobRawSource, jobsWithPages);

    // F1b/F4b: mechanical quote verify/repair on this phase's newly-created
    // pages, BEFORE the provenance stamp / reverse-write / embed sweep so the
    // stamp, the markdown file, and the embedded chunks all carry the
    // repaired body. Fail-open (abort still unwinds); kill switch:
    // dream.synthesize.quote_verify=false.
    let quoteVerifyStats: QuoteVerifyStats | null = null;
    if (config.quoteVerify && writtenRefs.length > 0) {
      const transcriptsForVerify = new Map<string, TranscriptForVerify>(
        worthProcessing.map(t => [t.filePath, { content: t.content, hash6: t.contentHash.slice(0, 6) }]),
      );
      try {
        quoteVerifyStats = await verifyAndRepairDreamPages(engine, writtenRefs, transcriptsForVerify, { signal: opts.signal });
      } catch (e) {
        throwIfAborted(opts.signal, '[dream] quote verify');
        process.stderr.write(`[dream] quote verify pass failed open: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    // #2569: persist the dream-output identity marker into the DB frontmatter
    // of every child-written page BEFORE reverse-rendering, so generated pages
    // are queryable (`frontmatter->>'dream_generated'`) and a later put_page
    // write-through (which re-renders from the DB row) can't erase the stamp.
    await stampDreamProvenance(engine, writtenRefs, summaryDate, opts.signal);

    // Dual-write: reverse-render each DB row → markdown file.
    const reverseWriteCount = await reverseWriteRefs(engine, opts.brainDir, writtenRefs, cycleSourceId, opts.signal);

    // Summary index page (deterministic; orchestrator-written via direct
    // engine.putPage so no allow-list path needed).
    const summarySlug = buildDreamSummarySlug(config.outputRoot, summaryDate);
    // Back-compat: writeSummaryPage takes string[] for display; map refs back to slugs.
    const writtenSlugs = writtenRefs.map(r => r.slug);
    if (SUMMARY_SLUG_RE.test(summarySlug)) {
      await writeSummaryPage(engine, opts.brainDir, summarySlug, summaryDate, writtenSlugs, childOutcomes, cycleSourceId, opts.signal);
    }

    // #4077: nothing below runs for a cancelled cycle — no phase-end embed
    // spend, no cooldown stamp (the next run must retry these transcripts).
    throwIfAborted(opts.signal, '[dream] synthesize completion');

    // CDX-8: deferred-embed closure. Oneshot children write chunks with
    // `embedding IS NULL`; the global `embed` phase only runs on SOME
    // invocation shapes (autopilot per-source cycles run NON_GLOBAL_PHASES,
    // and `--phase synthesize` never reaches it), so close the freshness gap
    // HERE. Runs whenever this phase wrote pages REGARDLESS of the current
    // mode (a revert to agentic must still sweep debt left by earlier oneshot
    // runs — cheap no-op when nothing is stale), and is BOUNDED by a 120s
    // abort signal: the stale backlog can predate this run (embeds disabled
    // for a while, big noEmbed sync) and an unbounded sweep would block the
    // phase past the cycle-lock TTL. The standing stale-embed machinery owns
    // any remainder. Best-effort: never fails a phase that wrote its pages.
    if (writtenSlugs.length > 0) {
      try {
        const { isAvailable } = await import('../ai/gateway.ts');
        if (isAvailable('embedding')) {
          const { embedStalePages } = await import('../embed-stale.ts');
          const { currentEmbeddingSignature } = await import('../embedding.ts');
          // Scoped to THIS phase's written pages only — the spend is exactly
          // the deferred cost of our own writes (what the agentic inline
          // path would have paid at put_page time), so it needs no backfill
          // lock, budget ledger, or cooldown; the source-wide stale backlog
          // stays the budget-tracked embed-backfill job's business. Racing a
          // concurrent backfill is idempotent (it finds these chunks
          // embedded). Signature stamping keeps the new pages inside the
          // v0.41.31 model-drift invalidation contract.
          const embedSig = currentEmbeddingSignature();
          const embedRes = await embedStalePages(engine, writtenSlugs, cycleSourceId, {
            signal: AbortSignal.timeout(120_000),
            ...(embedSig !== null && { embeddingSignature: embedSig }),
          });
          if (embedRes.embedded > 0) {
            process.stderr.write(`[dream] phase-end embed of written pages: ${embedRes.embedded} chunk(s)${embedRes.aborted ? ' (120s budget hit; stale sweep owns the rest)' : ''}.\n`);
          }
        }
      } catch (e) {
        process.stderr.write(`[dream] phase-end embed failed (the stale-embed sweep will catch up): ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    // #4194 telemetry: queue-wait + runtime percentiles from the children's
    // own timestamps, so a slow-but-healthy cycle is observable while it
    // drains and a concurrency change shows up as a queue-wait drop.
    let queueWaitP50: number | null = null;
    let queueWaitP95: number | null = null;
    let runtimeP50: number | null = null;
    let runtimeP95: number | null = null;
    // F6 child spend: summed from minion_jobs token columns — the ONE
    // authority for child spend (children's gateway rows in chat_usage_log
    // keep their own job:* phase tag; never sum both ledgers). minion_jobs
    // has NO cache-write column, hence the honest cost_basis label below.
    let childTokensIn = 0;
    let childTokensOut = 0;
    let childTokensCacheRead = 0;
    try {
      const timing = await engine.executeRaw<{ created_at: Date | string; started_at: Date | string | null; finished_at: Date | string | null; tokens_input: number | string | null; tokens_output: number | string | null; tokens_cache_read: number | string | null }>(
        `SELECT created_at, started_at, finished_at, tokens_input, tokens_output, tokens_cache_read FROM minion_jobs WHERE id = ANY($1::bigint[])`,
        [childIds],
      );
      const ts = (v: Date | string | null): number | null => v == null ? null : (v instanceof Date ? v.getTime() : new Date(v).getTime());
      const num = (v: number | string | null): number => v == null ? 0 : Number(v) || 0;
      const waits: number[] = [];
      const runtimes: number[] = [];
      for (const row of timing) {
        const created = ts(row.created_at);
        const started = ts(row.started_at);
        const finished = ts(row.finished_at);
        if (created != null && started != null && started >= created) waits.push(started - created);
        if (started != null && finished != null && finished >= started) runtimes.push(finished - started);
        childTokensIn += num(row.tokens_input);
        childTokensOut += num(row.tokens_output);
        childTokensCacheRead += num(row.tokens_cache_read);
      }
      queueWaitP50 = percentile(waits, 50);
      queueWaitP95 = percentile(waits, 95);
      runtimeP50 = percentile(runtimes, 50);
      runtimeP95 = percentile(runtimes, 95);
    } catch { /* telemetry is best-effort */ }
    // Child cost is an ESTIMATE priced at the configured synthesize model
    // (minion_jobs does not record per-job model); null when unpriced.
    const childCostUsd = priceChatUsd(config.model, { in: childTokensIn, out: childTokensOut, cacheRead: childTokensCacheRead });
    const spendBlock = {
      cost_basis: 'in+out+cache_read' as const,
      children: {
        tokens_in: childTokensIn,
        tokens_out: childTokensOut,
        tokens_cache_read: childTokensCacheRead,
        cost_usd: childCostUsd,
      },
      triage: {
        tokens_in: triageDetails.tokens_in,
        tokens_out: triageDetails.tokens_out,
        cost_usd: triageDetails.cost_usd,
      },
      total_usd: childCostUsd != null && triageDetails.cost_usd != null
        ? Math.round((childCostUsd + triageDetails.cost_usd) * 1e6) / 1e6
        : null,
    };

    // CDX-4 phase outcome gate: dead children must not masquerade as a clean
    // phase. Vocabulary discipline: 'dead'/'cancelled' are TERMINAL failures
    // (nothing will ever be written for that key); 'timeout' means the PARENT
    // stopped waiting — the child's real outcome is unknown and may still
    // land, so it degrades the phase but is never grounds for the ALL-DEAD
    // error. ALL children terminally failed → the phase itself failed (mirror
    // patterns.ts's outcome gate — "22 dead jobs, zero pages, phase ok" was
    // barely better than the #4217 incident). ANY child non-completed → the
    // cooldown stamp is SKIPPED: dead jobs release their idempotency keys
    // (queue.ts), so the next nightly run retries exactly the failed
    // transcripts instead of being suppressed for cooldown_hours.
    const deadChildren = childOutcomes.filter(o => o.status === 'dead' || o.status === 'cancelled');
    const failedChildren = childOutcomes.filter(o => o.status !== 'completed');
    if (childOutcomes.length > 0 && deadChildren.length === childOutcomes.length) {
      return failed(makeError('InternalError', 'SYNTH_ALL_CHILDREN_DEAD',
        `all ${childOutcomes.length} synthesis child job(s) ended '${deadChildren[0].status}' ` +
        `(${deadChildren.map(o => `${o.jobId}:${o.status}`).slice(0, 5).join(', ')}${deadChildren.length > 5 ? ', …' : ''}); ` +
        `nothing was written — see minion_jobs error_text for the cause`),
        // Keep fan-out observability on the failure path: operators (and the
        // fan-out-shape tests) still see what was submitted and how it died.
        {
          transcripts_discovered: transcripts.length,
          children_submitted: childIds.length,
          child_outcomes: childOutcomes,
          skips: skipReports,
          verdicts,
          triage: triageDetails,
          synthesis: {
            jobs: childIds.length,
            max_turns_config: config.maxTurns,
            inline_concurrency_config: config.inlineConcurrency,
            inline_concurrency_effective: effectiveConcurrency,
            dead_jobs: deadChildren.length,
            degraded: true,
            // F6: dead children may still have burned tokens before dying.
            spend: spendBlock,
          },
        });
    }

    // Write completion timestamp ON SUCCESS only — and only when every child
    // completed (CDX-4: the cooldown must not suppress the retry of failed or
    // still-unknown keys) AND nothing was budget-deferred (#4168 adversarial:
    // "deferred transcripts retry next cycle" is a lie if the next cycle is
    // cooldown-skipped for half a day).
    if (failedChildren.length === 0 && budgetExhaustedDeferrals.length === 0) {
      await engine.setConfig('dream.synthesize.last_completion_ts', new Date().toISOString());
    } else {
      process.stderr.write(
        `[dream] synthesize: ${failedChildren.length}/${childOutcomes.length} child job(s) incomplete + ${budgetExhaustedDeferrals.length} deferred — cooldown NOT stamped so the next run retries them.\n`,
      );
    }

    const ms = Date.now() - start;
    // Adversarial F3: deferred transcripts were NOT synthesized — a run that
    // deferred 8 of 10 must not report "10 synthesized".
    const submittedTranscripts = Math.max(
      0,
      worthProcessing.length - skipReports.length - budgetExhaustedDeferrals.length,
    );
    const turnsSamples = childOutcomes.filter(
      (o): o is { jobId: number; status: string; turns: number } => typeof o.turns === 'number',
    );
    return ok(`${submittedTranscripts} transcript(s) synthesized in ${(ms / 1000).toFixed(1)}s${deferralSuffix}`, {
      transcripts_discovered: transcripts.length,
      transcripts_processed: submittedTranscripts,
      pages_written: writtenSlugs.length,
      // v0.29: emit the slug list so the recompute_emotional_weight phase can
      // union with sync's pagesAffected and recompute weights for every page
      // synthesize wrote in this cycle.
      written_slugs: writtenSlugs,
      reverse_write_count: reverseWriteCount,
      child_outcomes: childOutcomes,
      // Children submitted (one per chunk for chunked transcripts; one per
      // transcript for single-chunk). Differs from transcripts_processed
      // when chunking is in play.
      children_submitted: childIds.length,
      budget_deferred_transcripts: budgetExhaustedDeferrals,
      // D5 cap hits + D8 legacy-key skips + daily_cap_reached. Empty when nothing skipped.
      skips: skipReports,
      summary_slug: summarySlug,
      verdicts,
      triage: triageDetails,
      synthesis: {
        jobs: childIds.length,
        max_turns_config: config.maxTurns,
        avg_turns: turnsSamples.length > 0
          ? Math.round((turnsSamples.reduce((a, o) => a + o.turns, 0) / turnsSamples.length) * 10) / 10
          : null,
        // #4216 execution-path mix.
        mode: config.mode,
        oneshot_jobs: childOutcomes.filter(o => o.synth_mode_used === 'oneshot').length,
        fallback_jobs: childOutcomes.filter(o => o.synth_mode_used === 'agentic_fallback').length,
        agentic_jobs: childOutcomes.filter(o => o.synth_mode_used === 'agentic').length,
        fallback_reasons: childOutcomes.reduce<Record<string, number>>((acc, o) => {
          if (o.fallback_reason) acc[o.fallback_reason] = (acc[o.fallback_reason] ?? 0) + 1;
          return acc;
        }, {}),
        // #4194 drain observability.
        inline_concurrency_config: config.inlineConcurrency,
        inline_concurrency_effective: effectiveConcurrency,
        drain_ms: drainMs,
        queue_wait_ms_p50: queueWaitP50,
        queue_wait_ms_p95: queueWaitP95,
        child_runtime_ms_p50: runtimeP50,
        child_runtime_ms_p95: runtimeP95,
        // CDX-4: dead-child visibility (0 on a clean run). dead_jobs counts
        // TERMINAL failures only (dead/cancelled — same semantics as the
        // failure-path details); non_completed_jobs additionally includes
        // 'timeout' (parent stopped waiting, outcome unknown).
        dead_jobs: deadChildren.length,
        non_completed_jobs: failedChildren.length,
        degraded: failedChildren.length > 0,
        // F6 rule-D visibility: completed children that wrote ZERO pages —
        // the "significance passed but content still routine" disposition.
        // Distinguishes a child that declined (task D) from a triage miss.
        children_zero_pages: childOutcomes.filter(
          o => o.status === 'completed' && !jobsWithPages.has(o.jobId),
        ).length,
        // F1b/F4b telemetry (null when the kill switch is off or nothing
        // was written).
        quote_verify: quoteVerifyStats,
        // F6: phase spend, from the two authoritative sources (minion_jobs
        // child counters + triage pass usage). cost_usd null when unpriced.
        spend: spendBlock,
      },
    });
  } catch (e) {
    return failed(makeError('InternalError', 'SYNTH_PHASE_FAIL',
      e instanceof Error ? (e.message || 'synthesize phase threw') : String(e)));
  } finally {
    if (ownedPrivateQueue) {
      try {
        const cancelled = await ownedPrivateQueue.queue.reconcilePrivateQueue(
          ownedPrivateQueue.name,
          'private queue owner terminalized: synthesize phase ended',
        );
        if (cancelled.length > 0) {
          process.stderr.write(
            `[dream] synthesize reconciled ${cancelled.length} non-terminal child job(s) from ${ownedPrivateQueue.name}\n`,
          );
        }
      } catch (cleanupError) {
        // The phase result must survive a transient cleanup failure; Doctor
        // and waiting-TTL remain delayed backstops and will surface/reap it.
        process.stderr.write(
          `[dream] synthesize private-queue cleanup failed for ${ownedPrivateQueue.name}: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
        );
      }
    }
  }
}

// ── Config ────────────────────────────────────────────────────────────

export interface SynthTriageConfig {
  /** Resolved triage model. Precedence: models.dream.triage > models.dream.synthesize_verdict > dream.synthesize.verdict_model > tier utility. */
  model: string;
  /** Read-time gate (dream.triage.threshold, default 0.5, clamped [0,1]). 0 = synthesize everything judged. */
  threshold: number;
  /** Sample window (dream.triage.max_chars, default 24000, floor 1000). NOT part of cache validity. */
  maxChars: number;
  /** Judge output budget (dream.triage.max_tokens, default 2048, floor 256). NOT part of cache validity. */
  maxTokens: number;
  /** Wall-clock miss budget per pass (dream.triage.max_ms, default 300000, 0 = unlimited). */
  maxMs: number;
  /** Concurrent judge calls (dream.triage.concurrency, default 4, clamped [1,16]). */
  concurrency: number;
  /** F2 rescue band floor (dream.triage.rescue_floor, default 0.30, clamped [0,1]). */
  rescueFloor: number;
  /** F2 verified-segment minimum (dream.triage.rescue_min_segments, default 2; 0 = rescue OFF). */
  rescueMinSegments: number;
  /** F2 content_type allowlist (dream.triage.rescue_content_types CSV, lowercased). */
  rescueContentTypes: readonly string[];
}

export interface SynthConfig {
  enabled: boolean;
  corpusDir: string | null;
  meetingTranscriptsDir: string | null;
  minChars: number;
  excludePatterns: string[];
  model: string;
  triage: SynthTriageConfig;
  /** dream.synthesize.max_turns, default 16 (see DEFAULT_MAX_TURNS rationale), floor 1. */
  maxTurns: number;
  /** dream.synthesize.max_submissions_per_source_per_day, default 0 = disabled (D2D). Docs recommend 200 for busy deployments. */
  maxSubmissionsPerSourcePerDay: number;
  cooldownHours: number;
  /**
   * D1: Override the per-chunk token budget (model_context × HEADROOM_RATIO
   * by default). Floor MIN_PROMPT_TOKENS, no upper cap (model context wins).
   * Surface name follows PR #748: `dream.synthesize.max_prompt_tokens`.
   * `null` means use the model-context lookup.
   */
  maxPromptTokens: number | null;
  /**
   * D5/D10: Cap on chunks produced from a single transcript. On cap hit, the
   * transcript is logged + skipped (NOT cached in dream_verdicts — closes the
   * cache-poisoning class). Operator override:
   * `dream.synthesize.max_chunks_per_transcript`.
   */
  maxChunksPerTranscript: number;
  /**
   * #2415: top-level namespace for synthesized output (reflections, originals,
   * patterns). Config key `dream.synthesize.output_root`; default 'wiki' —
   * zero behavior change unless set. No trailing slash. Must satisfy the slug
   * grammar; invalid values fall back to 'wiki' with a stderr warning.
   */
  outputRoot: string;
  /**
   * #4117: per-lane namespaces (see loadDreamNamespaces). Defaults derive
   * from outputRoot; config keys dream.synthesize.reflections_slug_prefix /
   * dream.synthesize.originals_slug_prefix override them individually.
   */
  reflectionsPrefix: string;
  originalsPrefix: string;
  subagentTimeoutMs: number;
  subagentWaitTimeoutMs: number;
  /**
   * #4194: concurrent inline-drain loops for this phase's private child
   * queue. Config `dream.synthesize.inline_concurrency`, default 1 (serial —
   * the pre-#4194 behavior), clamped [1,8]. PGLite is FORCED serial at the
   * callsite (exclusive-engine safety). Provider ceilings stay with the rate
   * leases — this knob only parallelizes the drain machinery.
   */
  inlineConcurrency: number;
  /**
   * F1b kill switch: mechanical quote verify/repair on newly-created dream
   * pages. Config `dream.synthesize.quote_verify`, default ON — the incident
   * escape hatch for the one mechanism that rewrites page bodies.
   */
  quoteVerify: boolean;
  /**
   * #4216: inject the pre-retrieval LINK CANDIDATES manifest into the
   * synthesis prompt (both modes). Config `dream.synthesize.link_manifest`,
   * default true. Zero-embed retrieval from triage entities/segments; turning
   * it off restores the pre-wave "search for targets yourself" prompt.
   */
  linkManifest: boolean;
  /**
   * #4216: synthesis execution mode. 'oneshot' (DEFAULT) = one structured
   * completion + programmatic validated writes with automatic per-transcript
   * fallback to the agentic loop; 'agentic' = the classic multi-turn tool
   * loop. Config `dream.synthesize.mode`; unknown values warn + default.
   * Revert dial: `gbrain config set dream.synthesize.mode agentic`.
   */
  mode: 'agentic' | 'oneshot';
}

/** Keep orchestrator summaries inside a configured non-default namespace. */
export function buildDreamSummarySlug(outputRoot: string, summaryDate: string): string {
  return outputRoot === 'wiki'
    ? `dream-cycle-summaries/${summaryDate}`
    : `${outputRoot}/dream-cycle-summaries/${summaryDate}`;
}

/** #2415: shared output-root resolution (synthesize + patterns phases). */
export async function loadOutputRoot(engine: BrainEngine): Promise<string> {
  const raw = await engine.getConfig('dream.synthesize.output_root');
  if (!raw) return 'wiki';
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (SUMMARY_SLUG_RE.test(trimmed)) return trimmed;
  process.stderr.write(
    `[dream] dream.synthesize.output_root "${raw}" is not a valid slug prefix; falling back to "wiki".\n`,
  );
  return 'wiki';
}

/**
 * #4117: per-lane output namespaces. `dream.synthesize.output_root` moves
 * the whole tree; these two keys move the REFLECTIONS and ORIGINALS lanes
 * individually (brains whose schema has no `personal/reflections` /
 * `originals/ideas` convention). SUMMARY_SLUG_RE-validated with a stderr
 * warning + default fallback — an invalid value can never leak an
 * unvalidated prefix into the prompt or the write allow-list (fail-closed:
 * the derived allow-list glob only ever comes from a validated prefix).
 * Mirrors the `dream.patterns.{source,output}_slug_prefix` shape.
 */
export interface DreamNamespaces {
  /** Where reflections land. Config `dream.synthesize.reflections_slug_prefix`; default `<output_root>/personal/reflections`. */
  reflectionsPrefix: string;
  /** Where originals land. Config `dream.synthesize.originals_slug_prefix`; default `<output_root>/originals/ideas`. */
  originalsPrefix: string;
}

export async function loadDreamNamespaces(
  engine: BrainEngine,
  outputRoot: string,
): Promise<DreamNamespaces> {
  const resolvePrefix = async (key: string, fallback: string): Promise<string> => {
    const raw = await engine.getConfig(key);
    if (!raw) return fallback;
    const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
    if (SUMMARY_SLUG_RE.test(trimmed)) return trimmed;
    process.stderr.write(
      `[dream] ${key} "${raw}" is not a valid slug prefix; falling back to "${fallback}".\n`,
    );
    return fallback;
  };
  return {
    reflectionsPrefix: await resolvePrefix(
      'dream.synthesize.reflections_slug_prefix', `${outputRoot}/personal/reflections`,
    ),
    originalsPrefix: await resolvePrefix(
      'dream.synthesize.originals_slug_prefix', `${outputRoot}/originals/ideas`,
    ),
  };
}

export async function loadSynthConfig(engine: BrainEngine): Promise<SynthConfig> {
  const enabledRaw = await engine.getConfig('dream.synthesize.enabled');
  const corpusDir = await engine.getConfig('dream.synthesize.session_corpus_dir');
  // v2: enabled defaults to true when corpus dir is configured, false otherwise.
  // Explicit enabled=false still wins for pausing synthesis without removing corpus config.
  const enabled = enabledRaw === 'false' ? false : (enabledRaw === 'true' || !!corpusDir);
  const meetingTranscriptsDir = await engine.getConfig('dream.synthesize.meeting_transcripts_dir');
  const excludeStr = await engine.getConfig('dream.synthesize.exclude_patterns');
  // v0.28: resolveModel() unifies CLI flag > new key > deprecated key > models.default > env > fallback
  const { resolveModel, resolveAlias } = await import('../model-config.ts');
  const model = await resolveModel(engine, {
    configKey: 'models.dream.synthesize',
    deprecatedConfigKey: 'dream.synthesize.model',
    tier: 'reasoning',
    fallback: 'sonnet',
  });
  // #4152 (eng-review 2A): `models.dream.triage` is the preferred key, read
  // via an EXPLICIT pre-read (not resolveModel's cliFlag slot — that slot
  // stays free for a future real CLI flag). Both legacy spellings keep
  // resolving through the standard chain when the new key is unset.
  const triageModelOverride = await engine.getConfig('models.dream.triage');
  const verdictModel = triageModelOverride?.trim()
    ? await resolveAlias(engine, triageModelOverride.trim())
    : await resolveModel(engine, {
        configKey: 'models.dream.synthesize_verdict',
        deprecatedConfigKey: 'dream.synthesize.verdict_model',
        tier: 'utility',
        fallback: 'haiku',
      });
  // Triage knobs. getNumberConfig honors a configured 0 where 0 is meaningful
  // (threshold 0 = synthesize everything judged; max_ms 0 = unlimited).
  let triageThreshold = await getNumberConfig(engine, 'dream.triage.threshold', DEFAULT_TRIAGE_THRESHOLD);
  if (triageThreshold < 0 || triageThreshold > 1) {
    process.stderr.write(
      `[dream] dream.triage.threshold ${triageThreshold} is outside [0,1]; clamping.\n`,
    );
    triageThreshold = Math.min(1, Math.max(0, triageThreshold));
  }
  const triageMaxChars = Math.max(1000, await getNumberConfig(engine, 'dream.triage.max_chars', DEFAULT_TRIAGE_MAX_CHARS));
  const triageMaxTokens = Math.max(256, await getNumberConfig(engine, 'dream.triage.max_tokens', DEFAULT_TRIAGE_MAX_TOKENS));
  const triageMaxMs = Math.max(0, await getNumberConfig(engine, 'dream.triage.max_ms', DEFAULT_TRIAGE_MAX_MS));
  const triageConcurrency = Math.max(1, Math.min(16,
    Math.floor(await getNumberConfig(engine, 'dream.triage.concurrency', DEFAULT_TRIAGE_CONCURRENCY)) || 1));
  // F2 rescue knobs. A floor above the threshold makes the band empty — a
  // harmless no-op, so no cross-clamp against the threshold is needed.
  // getNumberConfig honors 0 (rescue_min_segments 0 = kill switch).
  const rescueFloor = Math.min(1, Math.max(0,
    await getNumberConfig(engine, 'dream.triage.rescue_floor', DEFAULT_RESCUE_FLOOR)));
  const rescueMinSegments = Math.max(0,
    Math.floor(await getNumberConfig(engine, 'dream.triage.rescue_min_segments', DEFAULT_RESCUE_MIN_SEGMENTS)));
  const rescueContentTypesRaw = (await engine.getConfig('dream.triage.rescue_content_types'))?.trim();
  const rescueContentTypes = rescueContentTypesRaw
    ? rescueContentTypesRaw.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0)
    : DEFAULT_RESCUE_CONTENT_TYPES;
  const maxTurns = Math.max(1, Math.floor(await getNumberConfig(engine, 'dream.synthesize.max_turns', DEFAULT_MAX_TURNS)) || 1);
  const maxSubmissionsPerSourcePerDay = Math.max(0,
    Math.floor(await getNumberConfig(engine, 'dream.synthesize.max_submissions_per_source_per_day', 0)));
  // getNumberConfig (not `parseInt(str, 10) || N`) so a configured 0 is honored — a bare
  // `|| N` coerces an explicit 0 back to the default (cooldown 0 = "no cooldown").
  const cooldownHours = Math.max(0, await getNumberConfig(engine, 'dream.synthesize.cooldown_hours', 12));
  const minChars = Math.max(0, await getNumberConfig(engine, 'dream.synthesize.min_chars', 2000));
  const maxPromptTokensStr = await engine.getConfig('dream.synthesize.max_prompt_tokens');
  const maxChunksStr = await engine.getConfig('dream.synthesize.max_chunks_per_transcript');
  const subagentTimeoutMs = await getNumberConfig(
    engine,
    'dream.synthesize.subagent_timeout_ms',
    DEFAULT_SUBAGENT_TIMEOUT_MS,
  );
  const subagentWaitTimeoutMs = await getNumberConfig(
    engine,
    'dream.synthesize.subagent_wait_timeout_ms',
    DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
  );
  // #4194: clamp [1,8] — 8 stays under the default lease cap (32) so a
  // misconfigured pool can never self-starve the provider bucket.
  const inlineConcurrency = Math.max(1, Math.min(8,
    Math.floor(await getNumberConfig(engine, 'dream.synthesize.inline_concurrency', 1)) || 1));
  // #4216: manifest default ON; only an explicit 'false'/'0'/'off' disables.
  const linkManifestRaw = (await engine.getConfig('dream.synthesize.link_manifest'))?.trim().toLowerCase();
  const linkManifest = !(linkManifestRaw === 'false' || linkManifestRaw === '0' || linkManifestRaw === 'off');
  // F1b kill switch (same off-spelling contract as link_manifest).
  const quoteVerifyRaw = (await engine.getConfig('dream.synthesize.quote_verify'))?.trim().toLowerCase();
  const quoteVerify = !(quoteVerifyRaw === 'false' || quoteVerifyRaw === '0' || quoteVerifyRaw === 'off');
  // #4216: mode default 'oneshot' (D1=A). loadOutputRoot pattern: unknown
  // values warn to stderr and fall back to the default rather than failing.
  const modeRaw = (await engine.getConfig('dream.synthesize.mode'))?.trim().toLowerCase();
  let synthMode: 'agentic' | 'oneshot' = 'oneshot';
  if (modeRaw === 'agentic') synthMode = 'agentic';
  else if (modeRaw && modeRaw !== 'oneshot') {
    process.stderr.write(`[dream] dream.synthesize.mode "${modeRaw}" is not 'oneshot' | 'agentic'; using 'oneshot'.\n`);
  }

  let excludePatterns: string[] = [...DEFAULT_EXCLUDE_PATTERNS];
  if (excludeStr) {
    try {
      const parsed = JSON.parse(excludeStr);
      if (Array.isArray(parsed)) excludePatterns = parsed.filter(p => typeof p === 'string');
    } catch { /* keep default */ }
  }

  // D1: max_prompt_tokens floored at MIN_PROMPT_TOKENS; null → use model lookup.
  let maxPromptTokens: number | null = null;
  if (maxPromptTokensStr) {
    const parsed = parseInt(maxPromptTokensStr, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxPromptTokens = Math.max(MIN_PROMPT_TOKENS, parsed);
    }
  }
  // D10: max_chunks default 24, floor 1.
  let maxChunksPerTranscript = DEFAULT_MAX_CHUNKS;
  if (maxChunksStr) {
    const parsed = parseInt(maxChunksStr, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      maxChunksPerTranscript = parsed;
    }
  }

  // #4117: resolve the root once, then the per-lane namespaces from it.
  const outputRoot = await loadOutputRoot(engine);
  const namespaces = await loadDreamNamespaces(engine, outputRoot);

  return {
    enabled,
    corpusDir: corpusDir ?? null,
    meetingTranscriptsDir: meetingTranscriptsDir ?? null,
    minChars,
    excludePatterns,
    model,
    triage: {
      model: verdictModel,
      threshold: triageThreshold,
      maxChars: triageMaxChars,
      maxTokens: triageMaxTokens,
      maxMs: triageMaxMs,
      concurrency: triageConcurrency,
      rescueFloor,
      rescueMinSegments,
      rescueContentTypes,
    },
    maxTurns,
    maxSubmissionsPerSourcePerDay,
    cooldownHours,
    maxPromptTokens,
    maxChunksPerTranscript,
    outputRoot,
    // #4117: per-lane namespaces derived from outputRoot unless overridden.
    ...namespaces,
    subagentTimeoutMs,
    subagentWaitTimeoutMs,
    inlineConcurrency,
    quoteVerify,
    linkManifest,
    mode: synthMode,
  };
}

/**
 * Count dream synth-v2 subagent submissions for a source in the last 24h —
 * the opt-in daily-cap denominator. Filters on `data->>'source_id'` (NOT a
 * LIKE on the key's encoded source segment — avoids LIKE-metachar issues);
 * cancelled rows are excluded so retriage-cancelled jobs don't eat budget.
 */
async function countRecentSynthSubmissions(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM minion_jobs
      WHERE name = 'subagent'
        AND idempotency_key LIKE 'dream:synth-v2:%'
        AND COALESCE(NULLIF(data->>'source_id', ''), 'default') = $1
        AND status <> 'cancelled'
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [sourceId],
  );
  return rows[0]?.n ?? 0;
}

async function getNumberConfig(
  engine: BrainEngine,
  key: string,
  fallback: number,
): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  return Number.isNaN(value) ? fallback : value;
}

async function checkCooldown(
  engine: BrainEngine,
  hours: number,
): Promise<{ active: boolean; expires_at?: string }> {
  if (hours <= 0) return { active: false };
  const last = await engine.getConfig('dream.synthesize.last_completion_ts');
  if (!last) return { active: false };
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return { active: false };
  const expiresMs = lastMs + hours * 60 * 60 * 1000;
  if (Date.now() >= expiresMs) return { active: false };
  return { active: true, expires_at: new Date(expiresMs).toISOString() };
}

// ── Allow-list source of truth ───────────────────────────────────────
// #2397: peeled to filing-rules.ts (cwd > engine-resolved brain repo >
// __dirname > bundled-JSON ladder). Re-exported below so patterns.ts and
// the tests keep importing from here.

// ── Significance judge (gateway-routed; provider-agnostic) ──────────────
//
// The JudgeClient interface keeps the legacy create(params) call shape for
// test-seam stability — existing mocks keep working (the options bag is
// optional, #4077 cooperative cancellation). Only the construction path
// moved from `new Anthropic()` to
// `gateway.chat()` so any provider with a registered recipe (Anthropic,
// DeepSeek, OpenRouter, Voyage, Ollama, llama-server, etc.) is reachable
// via `gbrain config set models.dream.synthesize_verdict <provider>:<model>`.
//
// This mirrors v0.35.5.0's `tryBuildGatewayClient` in src/core/think/index.ts
// (which closed #952 for runThink). Same pattern, same trade-offs:
// construction-time provider/key probe returns null on a clear miss (cheap
// pre-flight), and the verdict loop wraps the actual chat call in try/catch
// for AIConfigError surfacing mid-run.

export interface JudgeClient {
  create: (
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ) => Promise<Anthropic.Message>;
}

/**
 * Build a gateway-routed JudgeClient for the resolved verdict model.
 * Returns null when no chat provider is reachable for `verdictModel`:
 *   - Unknown provider id (resolveRecipe throws AIConfigError).
 *   - Anthropic provider with no key (env or config) — preserves the legacy
 *     "no ANTHROPIC_API_KEY" cheap-skip semantics.
 * On null, the verdict loop short-circuits each transcript with an explicit
 * "no configured provider" reason and continues the phase.
 *
 * For non-Anthropic providers (deepseek, openrouter, voyage, ollama,
 * llama-server, ...), we delegate auth probing to the gateway's own
 * recipe `auth_env.required` machinery — AIConfigError at gateway.chat()
 * time is caught by the verdict loop and surfaced per-transcript.
 */
export function makeJudgeClient(verdictModel: string): JudgeClient | null {
  // Normalize: ensure provider:model shape (and slash→colon — #1698). resolveModel
  // returns bare anthropic ids (e.g. `claude-haiku-4-5`); gateway.chat needs `anthropic:...`.
  const modelStr = normalizeModelId(verdictModel);

  // #1698 (C1): id-validity via the shared `validateModelId` core (resolveRecipe +
  // assertTouchpoint) — catches unknown provider AND chat-less provider (model-id
  // typos pass locally and fail at the provider; no runtime allowlist). We do NOT
  // use the full `probeChatModel` here: its `isAvailable` layer would reject
  // non-Anthropic-no-key providers and an unconfigured gateway, breaking the
  // deliberate per-transcript-degrade contract (and test A9). validateModelId reads
  // the recipe registry, not gateway _config, so it works pre-configureGateway().
  const v = validateModelId(modelStr);
  if (!v.ok) return null;

  // Anthropic key probe (legacy behavior preserved verbatim). Other providers' key
  // checks happen lazily at chat call time and surface as AIConfigError, which the
  // verdict loop catches per-transcript.
  if (v.parsed.providerId === 'anthropic' && !hasAnthropicKey()) return null;

  return {
    create: async (params, options): Promise<Anthropic.Message> => {
      // Map Anthropic.MessageCreateParamsNonStreaming → gateway.ChatOpts.
      // `judgeSignificance` always sends string content + string system,
      // and the adapter only TEXT-flattens the array-of-blocks shape —
      // `tool_use`, `tool_result`, image, and other non-text blocks become
      // empty strings. If a future caller wires tool-use or image content
      // through this client, extend the mapping instead of relying on the
      // current silent drop. Same pattern as think/index.ts:607-615.
      const messages = params.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content)
              ? m.content.map(b => ('text' in b ? b.text : '')).join('')
              : ''),
      }));
      const system = typeof params.system === 'string'
        ? params.system
        : (Array.isArray(params.system)
            ? params.system.map(b => ('text' in b ? b.text : '')).join('')
            : undefined);

      const result: ChatResult = await gatewayChat({
        model: modelStr,
        system,
        messages,
        maxTokens: params.max_tokens,
        // DeepSeek v4 thinks by default and bills reasoning as OUTPUT tokens
        // against max_tokens (recipe thinking_by_default, #4172) — same for
        // OpenRouter's DeepSeek hosts (#4758). The judge wants only the small
        // JSON verdict, so pin thinking off per-call — the openai-compatible
        // adapter spreads providerOptions[recipe.id] into the wire body,
        // where `thinking` is DeepSeek's documented knob.
        ...(v.parsed.providerId === 'deepseek'
          || (v.parsed.providerId === 'openrouter'
            && v.parsed.modelId.trim().toLowerCase().startsWith('deepseek/'))
          ? { providerOptions: { [v.parsed.providerId]: { thinking: { type: 'disabled' } } } }
          : {}),
        // #4077: a cancelled cycle tears down the in-flight judge call too.
        abortSignal: options?.signal,
      });

      // Map gateway.ChatResult → Anthropic.Message shape. judgeSignificance
      // reads `.content[0].type === 'text'`, `.content[0].text`, and
      // `.stop_reason`; other fields are best-effort for downstream
      // telemetry parity. The stopReason mapping is load-bearing:
      // 'length' → 'max_tokens' lets judgeSignificance detect a truncated
      // verdict (reasoning models can burn the whole max_tokens budget on
      // reasoning tokens, leaving empty/partial text) and
      // 'refusal'/'content_filter' → 'refusal' surfaces a blocked response,
      // instead of silently treating either as a clean end-of-turn.
      // 'other' (gateway's mapStopReason catch-all — unknown provider
      // finish reasons, which includes both non-standard SUCCESSFUL stops
      // and the AI SDK's 'error'/'unknown' labels) maps to 'end_turn'
      // deliberately. Rationale: (a) treating 'other' as abnormal would
      // permanently disable verdict caching on providers whose successful
      // stops the gateway doesn't recognize; (b) the residual risk is
      // narrow — an errored response only gets cached if it still contains
      // a complete, parseable JSON object with a finite numeric score in
      // [0,1] (unparseable output is never cached), and such a complete
      // verdict is trustworthy regardless of the finish label. Distinguishing
      // error/unknown from benign-unknown belongs in gateway.ts's
      // mapStopReason (out of scope here — see PR notes).
      return {
        id: '',
        type: 'message',
        role: 'assistant',
        model: modelStr,
        content: [{ type: 'text', text: result.text }],
        stop_reason: result.stopReason === 'length' ? 'max_tokens'
          : result.stopReason === 'tool_calls' ? 'tool_use'
          : (result.stopReason === 'refusal' || result.stopReason === 'content_filter') ? 'refusal'
          : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        },
      } as unknown as Anthropic.Message;
    },
  };
}

export interface TriageResult {
  /**
   * Ordinal salience score in [0,1] — NOT a calibrated probability.
   * Comparable only within (model, TRIAGE_VERSION), which is exactly the
   * cache-validity tuple. 0 on degenerate results (never cached anyway).
   */
  score: number;
  content_type: string | null;
  /** ≤8 candidate segments, quotes clipped to 300 chars, notes to 200. */
  segments: TriageSegment[];
  /** ≤12 entity candidates, each clipped to 80 chars. */
  entities: string[];
  /** Derived at judge time as `score >= DEFAULT_TRIAGE_THRESHOLD` (back-compat column). */
  worth_processing: boolean;
  reasons: string[];
  /**
   * Set when the judgement is degenerate and must NOT be cached in
   * dream_verdicts:
   *   'truncated'   — the response hit max_tokens (reasoning models can spend
   *                   the whole budget on reasoning tokens before emitting the
   *                   verdict JSON), so the verdict is unreliable;
   *   'refusal'     — the model refused or a provider content filter blocked
   *                   the response (stop_reason=refusal);
   *   'unparseable' — no JSON object with a finite numeric `score` in [0,1]
   *                   could be parsed out of the response. Out-of-range scores
   *                   land here deliberately — clamping would cache a
   *                   fabricated verdict.
   * runTriagePass skips putDreamVerdict for these so the next cycle re-judges
   * the transcript instead of permanently trusting a degenerate rejection.
   */
  unreliable?: 'truncated' | 'refusal' | 'unparseable';
  /**
   * F6: judge-call token usage when the client surfaced it (gateway clients
   * do; legacy SDK-shape mocks may not). Present on degenerate results too —
   * the call was paid whether or not the verdict parsed.
   */
  tokens?: { in: number; out: number };
}

/** Degenerate TriageResult factory — score 0, never cached (unreliable is always set). */
function degenerateTriage(
  unreliable: NonNullable<TriageResult['unreliable']>,
  reason: string,
): TriageResult {
  return {
    score: 0,
    content_type: null,
    segments: [],
    entities: [],
    worth_processing: false,
    reasons: [reason],
    unreliable,
  };
}

/**
 * Build the judge sample: full content when it fits in maxChars, else a
 * head 50% / middle 20% / tail 30% three-window sample so mid-transcript
 * signal is not structurally invisible to a cached verdict (#4152 C5).
 *
 * v0.41.13 surrogate-safety: every split index routes through safeSplitIndex
 * so an emoji at a window boundary never produces a lone surrogate that
 * Anthropic's JSON parser rejects ("no low surrogate in string", caught
 * 2026-05-24 on telegram). Contract: the sampling branch only runs when
 * content.length > maxChars (>= 1000 floor), so every raw index below is
 * strictly inside (0, length). The middle window is clamped between the head
 * and tail windows; when length is barely over maxChars the clamp collapses
 * it to nothing rather than duplicating head/tail content.
 */
function buildTriageSample(content: string, maxChars: number): { text: string; sampledPct: number | null } {
  if (content.length <= maxChars) return { text: content, sampledPct: null };
  const headLen = Math.floor(maxChars * 0.5);
  const midLen = Math.floor(maxChars * 0.2);
  const tailLen = maxChars - headLen - midLen;
  const headEnd = safeSplitIndex(content, headLen);
  const tailStart = safeSplitIndex(content, content.length - tailLen);
  const midStartRaw = Math.max(headEnd, Math.floor((content.length - midLen) / 2));
  const midEndRaw = Math.min(tailStart, midStartRaw + midLen);
  let middle = '';
  if (midEndRaw > midStartRaw) {
    const midStart = safeSplitIndex(content, midStartRaw);
    const midEnd = safeSplitIndex(content, midEndRaw);
    if (midEnd > midStart) middle = content.slice(midStart, midEnd) + '\n[...truncated...]\n';
  }
  const text = content.slice(0, headEnd) + '\n[...truncated...]\n' + middle + content.slice(tailStart);
  return { text, sampledPct: Math.max(1, Math.round((maxChars / content.length) * 100)) };
}

export async function judgeSignificance(
  client: JudgeClient,
  t: DiscoveredTranscript,
  verdictModel = 'claude-haiku-4-5-20251001',
  opts: { maxChars?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<TriageResult> {
  const maxChars = Math.max(1000, opts.maxChars ?? DEFAULT_TRIAGE_MAX_CHARS);
  const { text: trimmed, sampledPct } = buildTriageSample(t.content, maxChars);

  // Score bands are NON-OVERLAPPING with no gaps (outside-voice C7). The
  // score is an ordinal salience rating, not a calibrated probability;
  // comparability holds within (model, TRIAGE_VERSION) only — exactly the
  // cache-validity tuple runTriagePass enforces.
  const sys = `You triage a conversation transcript for synthesis into a personal knowledge brain.
Score how much durable, synthesis-worthy signal it contains.

HIGH signal (score 0.70-1.0):
- The user articulates a new idea, frame, mental model, or thesis
- The user reflects on themselves, names patterns, processes emotion
- The user discusses specific people, companies, or decisions in depth
- The user makes a strategic call worth remembering
Score by the transcript's PEAK signal, not its average: a mostly-routine
transcript containing one clearly synthesis-worthy passage scores by that
passage.
MEDIUM (score 0.30-0.69): some original thought mixed into routine content.
LOW (score 0.0-0.29): routine ops ("check my email", "schedule X"), pure code
debugging without reflection, short exchanges with no original thought,
repetitive content the brain already has.

Respond with ONLY a JSON object:
{
  "score": <number between 0.0 and 1.0>,
  "content_type": "<one of: reflection|idea|people|strategy|technical|routine|mixed>",
  "segments": [{"quote": "<verbatim quote from the transcript, max 200 chars>",
                "note": "<why it matters, max 12 words>"}],
  "entities": ["<person, company, or project named in the transcript>"],
  "reasons": ["<short phrase>", "<short phrase>"]
}
At most 8 segments (the most synthesis-worthy passages — prefer passages
carrying concrete facts and decisions), at most 12 entities, two reasons.
Quote verbatim; never paraphrase inside "quote".`;

  const msg = await client.create({
    model: verdictModel,
    // 2048: the segments+entities JSON needs ~700 tokens worst case, and
    // reasoning models spend output budget on reasoning tokens BEFORE the
    // visible text, so a tight cap gets eaten whole and the verdict comes
    // back empty/truncated. (Judge-call ballpark elsewhere: grade-takes.ts
    // 600, eval-contradictions/judge.ts 1024 — this one carries segments.)
    max_tokens: opts.maxTokens ?? DEFAULT_TRIAGE_MAX_TOKENS,
    system: sys,
    messages: [{ role: 'user', content: `Transcript ${t.basename}:\n\n${trimmed}` }],
  }, { signal: opts.signal });

  // stop_reason === 'max_tokens' means the response was cut off; 'refusal'
  // means the model refused or a content filter blocked it. Even if a
  // parseable JSON object survives either condition, don't trust it as a
  // durable verdict — mark it unreliable so the caller skips the
  // dream_verdicts write and the next cycle re-judges. (Legacy SDK-shape
  // clients and mocks without a stop_reason field land on undefined here,
  // which is treated as a clean stop — preserves the pre-existing contract.)
  // Widen: the pinned Anthropic SDK's stop_reason union predates 'refusal',
  // but the gateway adapter (and newer SDKs) can emit it.
  const stopReasonRaw = (msg as { stop_reason?: string | null }).stop_reason;
  const truncated = stopReasonRaw === 'max_tokens';
  // F6: capture judge-call usage once; attached to EVERY return below —
  // the call was paid whether or not the verdict came back reliable.
  const rawUsage = (msg as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
  const callTokens = rawUsage
    && typeof rawUsage.input_tokens === 'number' && Number.isFinite(rawUsage.input_tokens)
    && typeof rawUsage.output_tokens === 'number' && Number.isFinite(rawUsage.output_tokens)
    ? { in: rawUsage.input_tokens, out: rawUsage.output_tokens }
    : undefined;
  const withTokens = (r: TriageResult): TriageResult => (callTokens ? { ...r, tokens: callTokens } : r);
  const refused = stopReasonRaw === 'refusal';
  const abnormalStop: TriageResult['unreliable'] | undefined =
    truncated ? 'truncated' : refused ? 'refusal' : undefined;

  const text = msg.content
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  const parsed = parseLlmJson<{
    score?: unknown;
    content_type?: unknown;
    segments?: unknown;
    entities?: unknown;
    reasons?: unknown;
  }>(text);

  // Discriminant: a finite numeric score is REQUIRED. A JSON object without
  // one (`{}`, `{"score": "0.7"}`) is NOT a verdict — treat as unparseable
  // rather than coercing to a cacheable rejection.
  if (parsed && typeof parsed.score === 'number' && Number.isFinite(parsed.score)) {
    const score = parsed.score;
    // NEW rule vs the boolean era: out-of-range scores are degenerate, never
    // clamped — clamping would cache a fabricated verdict (same poison class
    // the unreliable contract exists to prevent).
    if (score < 0 || score > 1) {
      return withTokens(degenerateTriage('unparseable', `score out of range: ${score}`));
    }
    // Optional fields are LENIENT — bad shapes are dropped/nulled, never
    // unreliable on their own. Only the score is load-bearing.
    // Whitespace is COLLAPSED (not just trimmed) on every field that later
    // rides into the synthesis prompt: an interior newline in an LLM-produced
    // "quote" could otherwise spoof structural prompt lines in
    // buildTriageMapBlock (security review, #4152).
    const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const contentType = typeof parsed.content_type === 'string'
      ? collapse(parsed.content_type).toLowerCase().slice(0, 40) || null
      : null;
    const segments: TriageSegment[] = Array.isArray(parsed.segments)
      ? parsed.segments
          .filter((s): s is { quote: string; note?: unknown } =>
            !!s && typeof s === 'object' && typeof (s as { quote?: unknown }).quote === 'string'
            && (s as { quote: string }).quote.trim().length > 0)
          .slice(0, 8)
          .map(s => ({
            quote: collapse(s.quote).slice(0, 300),
            ...(typeof s.note === 'string' && s.note.trim() ? { note: collapse(s.note).slice(0, 200) } : {}),
          }))
      : [];
    const entities = Array.isArray(parsed.entities)
      ? parsed.entities
          .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
          .slice(0, 12)
          .map(e => collapse(e).slice(0, 80))
      : [];
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === 'string').slice(0, 4)
      : [];
    if (sampledPct !== null) reasons.push(`sampled: ~${sampledPct}% of transcript`);
    const result: TriageResult = {
      score,
      content_type: contentType,
      segments,
      entities,
      worth_processing: score >= DEFAULT_TRIAGE_THRESHOLD,
      reasons,
    };
    return withTokens(abnormalStop ? { ...result, unreliable: abnormalStop } : result);
  }

  // Couldn't parse a scored verdict — default to NOT processing this cycle,
  // but flag the result unreliable so it is never cached permanently.
  if (truncated) {
    return withTokens(degenerateTriage('truncated', 'judge response truncated (stop_reason=max_tokens)'));
  }
  if (refused) {
    return withTokens(degenerateTriage('refusal', 'judge response refused or content-filtered (stop_reason=refusal)'));
  }
  return withTokens(degenerateTriage('unparseable', 'judge response unparseable'));
}

// ── Synth-v2 idempotency-key grammar (#4152 retriage) ─────────────────

export interface ParsedSynthV2Key {
  source: string;
  basename: string;
  hash16: string;
  chunk?: { i: number; n: number };
}

/**
 * Parse a `dream:synth-v2:<source>:filename:<basename>:<hash16>[:c<i>of<n>]`
 * idempotency key. Returns null on anything outside the grammar (including
 * malformed percent-encoding) — retriage treats unparseable keys as
 * unmatched, never cancels on a guess. Lives next to the producer above so
 * the grammar can't drift.
 */
export function parseSynthV2Key(key: string): ParsedSynthV2Key | null {
  const m = /^dream:synth-v2:([^:]*):filename:([^:]*):([0-9a-f]{16})(?::c(\d+)of(\d+))?$/.exec(key);
  if (!m) return null;
  try {
    const source = decodeURIComponent(m[1]);
    const base = decodeURIComponent(m[2]);
    if (m[4] !== undefined && m[5] !== undefined) {
      return { source, basename: base, hash16: m[3], chunk: { i: parseInt(m[4], 10), n: parseInt(m[5], 10) } };
    }
    return { source, basename: base, hash16: m[3] };
  } catch {
    return null;
  }
}

// ── Triage pass (#4152) — shared by the synthesize phase and dream retriage ──

/**
 * Single source of truth for triage cache validity (#4152 C8). Lives next to
 * TRIAGE_VERSION so the tuple can't drift across its three consumers
 * (runTriagePass, retriage's dry-run reads, retriage's spend estimate).
 * A row is valid when it carries a score, matches BOTH the current prompt
 * version and the resolved model, and postdates `staleBefore` (when set).
 */
export function isTriageCacheValid(
  cached: Pick<DreamVerdict, 'score' | 'triage_version' | 'model' | 'judged_at'>,
  model: string,
  staleBefore?: Date,
): boolean {
  return cached.score !== null
    && cached.triage_version === TRIAGE_VERSION
    && cached.model === model
    && (!staleBefore || Date.parse(cached.judged_at) >= staleBefore.getTime());
}

/**
 * Liveness grace for per-run `dream-inline-<ms>-<uuid8>` queues (outside-voice
 * CX1). A queue younger than this may belong to a cycle that is STILL running
 * (children waiting for its inline drain) — neither retriage's backlog
 * conversion nor the fan-out self-heal may cancel rows in it. 1h comfortably
 * covers the 35-min default subagent wait + drain latency.
 */
export const DREAM_INLINE_LIVE_GRACE_MS = 60 * 60 * 1000;

/**
 * Parse the creation timestamp out of a `dream-inline-<ms>-<uuid8>` queue
 * name; null for anything outside the grammar. Used to decide whether a
 * private per-run queue is provably dead (older than the grace) or possibly
 * live.
 */
export function dreamInlineQueueAgeMs(queueName: string, nowMs = Date.now()): number | null {
  const m = /^dream-inline-(\d{10,16})-[0-9a-f]{8}$/.exec(queueName);
  if (!m) return null;
  const ts = Number(m[1]);
  if (!Number.isFinite(ts)) return null;
  return nowMs - ts;
}

/**
 * F6: price a chat call. Thin rounding wrapper over the ONE pricing routine
 * (chat-usage.ts estimateChatCostUsd — canonical table, cache_read falls
 * back to the input rate). Returns null when the model has no canonical
 * pricing — never a fake 0 (house rule).
 */
function priceChatUsd(model: string, tokens: { in: number; out: number; cacheRead?: number }): number | null {
  const usd = estimateChatCostUsd(model, {
    input_tokens: tokens.in,
    output_tokens: tokens.out,
    cache_read_tokens: tokens.cacheRead ?? 0,
  });
  return usd === null ? null : Math.round(usd * 1e6) / 1e6;
}

export interface TriagePassCfg {
  /** Resolved triage model (provider-prefixed or bare claude-*). Part of cache validity. */
  model: string;
  maxChars: number;
  maxTokens: number;
  /** Read-time gate; stamps `worth` on reports. Stored verdicts derive from DEFAULT_TRIAGE_THRESHOLD instead. */
  threshold: number;
  /** Concurrent judge calls, clamped [1,16]. */
  concurrency: number;
  /** Wall-clock budget (ms) for cache-MISS judging; 0 = unlimited. Hits are always free. */
  maxMs: number;
  /** #4077: cooperative cancellation — no new judge pulls, no post-abort
   *  dream_verdicts writes; the abort unwinds the pass (phase fails). */
  signal?: AbortSignal;
  /** Retriage: ignore the cache entirely. */
  force?: boolean;
  /** Retriage --since: cached rows judged before this instant are stale (re-judged). */
  staleBefore?: Date;
  /** Test seam: judge client override (null = simulate no reachable provider). */
  judge?: JudgeClient | null;
  /** Test seam: clock for the maxMs budget. */
  now?: () => number;
  /** Retriage --max-usd: called after each judged file; return true to stop pulling new misses. */
  shouldStop?: () => boolean;
  /**
   * F2 verified-segment rescue config. Defaults to DEFAULT_RESCUE_CONFIG so
   * every caller gets ONE gate semantics; pass the resolved config knobs from
   * loadSynthConfig where available. minSegments 0 disables the band.
   */
  rescue?: RescueConfig;
}

export interface TriageFileReport {
  filePath: string;
  /**
   * Passed the read-time gate — `score >= cfg.threshold` OR the F2
   * verified-segment rescue (passesTriageGate is the ONE decision every
   * consumer reads). False for degraded/deferred.
   */
  worth: boolean;
  /** F2: set (true) only when `worth` came from the rescue band. */
  rescued?: boolean;
  /** F2: verified substantive segments counted when the band was evaluated. */
  verified_segments?: number;
  score: number | null;
  content_type: string | null;
  reasons: string[];
  cached: boolean;
  unreliable?: string;
  /** True when the maxMs budget (or shouldStop) expired before this file could be judged. */
  deferred?: boolean;
}

export interface TriagePassResult {
  /** One report per transcript, in discovery order. */
  reports: TriageFileReport[];
  /** filePath → usable verdict (cache hit or fresh reliable judgment). Degraded/deferred files are absent. */
  byPath: Map<string, DreamVerdict>;
  judged: number;
  cacheHits: number;
  unreliable: number;
  deferred: number;
  /** F6: summed judge-call usage across cache MISSES this pass (hits are free). */
  tokens: { in: number; out: number };
}

/**
 * Run scored triage over a transcript set with a bounded worker pool.
 *
 * Cache validity (outside-voice C8): a dream_verdicts row is a HIT only when
 * `score` is non-null AND `triage_version === TRIAGE_VERSION` AND
 * `model === cfg.model` (switching models re-judges, bounded by maxMs) AND it
 * postdates `staleBefore` (when set) AND `force` is off. Legacy boolean-era
 * rows always miss. `maxChars`/`maxTokens` are deliberately NOT part of
 * validity — tuning them must not cold-restart the corpus; use
 * `gbrain dream retriage --force` to re-judge under new sampling knobs.
 *
 * Time budget: once `now() - start > maxMs` (>0), workers stop pulling new
 * MISSES — remaining misses are reported `deferred` (not cached, not
 * synthesized) and the next pass continues where this one stopped, because
 * hits are free. In-flight judge calls at expiry complete and ARE cached
 * (no torn judgments).
 *
 * Failure contract (byte-compatible with the pre-#4152 sequential loop):
 * a null judge client or an AIConfigError degrades PER TRANSCRIPT (reason
 * entry, nothing cached, phase continues); any other error aborts new pulls,
 * lets in-flight items settle, and rethrows (the phase fails).
 *
 * Lock renewal: `yieldDuringPhase` ticks at most once per 30s (single-flight).
 * The cycle lock has its own background refresher (cycle.ts
 * startCycleLockRefresher); this coarse tick serves the Minion JOB lock on
 * the hook path per the cycle.ts:618 split.
 */
export async function runTriagePass(
  engine: BrainEngine,
  transcripts: DiscoveredTranscript[],
  cfg: TriagePassCfg,
  yieldDuringPhase?: () => Promise<void>,
): Promise<TriagePassResult> {
  const now = cfg.now ?? Date.now;
  const start = now();
  const concurrency = Math.max(1, Math.min(16, Math.floor(cfg.concurrency) || 1));
  const judge = cfg.judge !== undefined ? cfg.judge : makeJudgeClient(cfg.model);

  const reports: TriageFileReport[] = new Array(transcripts.length);
  const byPath = new Map<string, DreamVerdict>();
  let judged = 0;
  let cacheHits = 0;
  let unreliableCount = 0;
  let deferredCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  let cursor = 0;
  let abortError: unknown = null;
  let stopped = false;

  // Coarse single-flight lock-renewal tick (at most every 30s).
  let lastTick = start;
  let tickInFlight = false;
  const maybeTick = (): void => {
    if (!yieldDuringPhase || tickInFlight || now() - lastTick < 30_000) return;
    tickInFlight = true;
    lastTick = now();
    yieldDuringPhase()
      .catch(() => { /* best-effort */ })
      .finally(() => { tickInFlight = false; });
  };

  const budgetExhausted = (): boolean =>
    stopped || (cfg.maxMs > 0 && now() - start > cfg.maxMs);

  // F2: THE gate — threshold pass or verified-segment rescue. Applied here at
  // report construction (not recomputed downstream) so `worth`, the
  // below_threshold count, dry-run output, the fan-out, and retriage all read
  // one decision.
  const rescueCfg = cfg.rescue ?? DEFAULT_RESCUE_CONFIG;
  const gate = (v: RescueVerdictLike, content: string) =>
    passesTriageGate(v, content, cfg.threshold, rescueCfg);

  const processOne = async (idx: number): Promise<void> => {
    const t = transcripts[idx];
    // Cache lookup is always free — never deferred by the time budget.
    const cached = cfg.force ? null : await engine.getDreamVerdict(t.filePath, t.contentHash);
    const cacheValid = cached !== null && isTriageCacheValid(cached, cfg.model, cfg.staleBefore);
    if (cached && cacheValid) {
      cacheHits++;
      byPath.set(t.filePath, cached);
      const g = gate(cached, t.content);
      reports[idx] = {
        filePath: t.filePath,
        worth: g.pass,
        ...(g.rescued ? { rescued: true, verified_segments: g.verified_segments } : {}),
        score: cached.score,
        content_type: cached.content_type,
        reasons: cached.reasons,
        cached: true,
      };
      return;
    }
    if (budgetExhausted()) {
      deferredCount++;
      reports[idx] = {
        filePath: t.filePath,
        worth: false,
        score: null,
        content_type: null,
        reasons: ['triage deferred: dream.triage.max_ms budget reached'],
        cached: false,
        deferred: true,
      };
      return;
    }
    if (!judge) {
      // No configured provider for the triage model — per-transcript degrade,
      // nothing cached, phase continues (pre-#4152 contract preserved).
      reports[idx] = {
        filePath: t.filePath,
        worth: false,
        score: null,
        content_type: null,
        reasons: [`no configured provider for verdict model: ${cfg.model}`],
        cached: false,
      };
      return;
    }
    // #4077: never START a judge call after cancellation; the in-flight call
    // below rides the same signal via the gateway's abortSignal.
    throwIfAborted(cfg.signal, '[dream] significance judge');
    try {
      let triage: TriageResult;
      try {
        triage = await judgeSignificance(judge, t, cfg.model, {
          maxChars: cfg.maxChars,
          maxTokens: cfg.maxTokens,
          signal: cfg.signal,
        });
      } finally {
        // Spend accounting (outside-voice CX3): the paid call happened whether
        // or not the verdict came back reliable — tick shouldStop on EVERY
        // judge attempt (including throws, conservatively) so --max-usd can't
        // be bypassed by refusals/truncations/unparseable responses.
        if (cfg.shouldStop?.()) stopped = true;
      }
      judged++;
      if (triage.tokens) {
        tokensIn += triage.tokens.in;
        tokensOut += triage.tokens.out;
      }
      if (triage.unreliable) {
        // Degenerate judgement — do NOT write it to dream_verdicts: a cached
        // rejection is permanent for this content hash, and a triage model
        // that reliably truncates would silently reject every transcript
        // forever. Log + skip so the next cycle re-judges.
        unreliableCount++;
        process.stderr.write(
          `[dream] triage for ${t.basename} was ${triage.unreliable} ` +
          `(${triage.reasons.join('; ')}); not caching in dream_verdicts — ` +
          `next cycle will re-judge ${t.filePath}\n`,
        );
        reports[idx] = {
          filePath: t.filePath,
          worth: false,
          score: null,
          content_type: null,
          reasons: triage.reasons,
          cached: false,
          unreliable: triage.unreliable,
        };
        return;
      }
      // #4077: a cancelled cycle must not bank new dream_verdicts rows for
      // work it is abandoning — the next run re-judges from a clean slate.
      throwIfAborted(cfg.signal, '[dream] significance judge');
      await engine.putDreamVerdict(t.filePath, t.contentHash, {
        worth_processing: triage.worth_processing,
        reasons: triage.reasons,
        score: triage.score,
        content_type: triage.content_type,
        segments: triage.segments,
        entities: triage.entities,
        model: cfg.model,
        triage_version: TRIAGE_VERSION,
      });
      byPath.set(t.filePath, {
        worth_processing: triage.worth_processing,
        reasons: triage.reasons,
        judged_at: new Date().toISOString(),
        score: triage.score,
        content_type: triage.content_type,
        segments: triage.segments,
        entities: triage.entities,
        model: cfg.model,
        triage_version: TRIAGE_VERSION,
      });
      const g = gate(triage, t.content);
      reports[idx] = {
        filePath: t.filePath,
        worth: g.pass,
        ...(g.rescued ? { rescued: true, verified_segments: g.verified_segments } : {}),
        score: triage.score,
        content_type: triage.content_type,
        reasons: triage.reasons,
        cached: false,
      };
    } catch (e) {
      // AIConfigError at chat time = provider auth/config went bad mid-run
      // (revoked key, recipe misconfig surfacing at first real call). Skip
      // this transcript with the gateway error message so the user sees the
      // shape of the problem in `gbrain dream --phase synthesize --dry-run`.
      if (e instanceof AIConfigError) {
        reports[idx] = {
          filePath: t.filePath,
          worth: false,
          score: null,
          content_type: null,
          reasons: [`gateway error: ${e.message}`],
          cached: false,
        };
        return;
      }
      throw e;
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (abortError !== null) return;
      const idx = cursor++;
      if (idx >= transcripts.length) return;
      try {
        await processOne(idx);
      } catch (e) {
        // Hard error: stop pulling new items; in-flight workers settle; the
        // first error propagates after the pool drains (phase fails, matching
        // the pre-#4152 `throw e`).
        if (abortError === null) abortError = e;
        return;
      }
      maybeTick();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, transcripts.length)) }, () => worker()),
  );
  if (abortError !== null) throw abortError;

  // Defensive: today every claimed index either sets its report or the pass
  // rethrows above, so no holes can exist — but a future early-exit path
  // must not silently break the index-stable `reports` contract callers
  // rely on, so fill any gap as deferred.
  for (let i = 0; i < transcripts.length; i++) {
    if (!reports[i]) {
      deferredCount++;
      reports[i] = {
        filePath: transcripts[i].filePath,
        worth: false,
        score: null,
        content_type: null,
        reasons: ['triage deferred: pass ended before this file was reached'],
        cached: false,
        deferred: true,
      };
    }
  }

  return { reports, byPath, judged, cacheHits, unreliable: unreliableCount, deferred: deferredCount, tokens: { in: tokensIn, out: tokensOut } };
}

// ── Subagent prompt ──────────────────────────────────────────────────

/**
 * Build the prompt for one subagent. When `chunkTotal > 1`, the slug seed
 * gains a `-c<idx>` suffix and the prompt names which chunk this is.
 *
 * D6 enforcement is orchestrator-side (rewriteChunkedSlug runs at slug-
 * collection time). Sonnet still gets the chunked seed via the prompt's
 * `USE THIS in slugs` rule for the happy path.
 */
/**
 * v0.32.6 M2 — Load prior probe findings into an informational block.
 * Returns '' if no probe runs exist or the engine doesn't know how (pre-v33
 * brain that hasn't applied migrations). Best-effort and silent on failure.
 */
async function loadPriorContradictionsBlock(engine: BrainEngine): Promise<string> {
  try {
    const rows = await engine.loadContradictionsTrend(30);
    if (!rows || rows.length === 0) return '';
    const latest = rows[0];
    const report = latest.report_json as Record<string, unknown> | null;
    const perQuery = (report?.per_query as Array<{
      contradictions: Array<{
        severity: 'low' | 'medium' | 'high';
        axis: string;
        a: { slug: string };
        b: { slug: string };
      }>;
    }> | undefined) ?? [];
    const findings: Array<{ severity: string; axis: string; a: string; b: string }> = [];
    for (const q of perQuery) {
      for (const c of q.contradictions) {
        findings.push({ severity: c.severity, axis: c.axis, a: c.a.slug, b: c.b.slug });
      }
    }
    if (findings.length === 0) return '';
    // Sort by severity DESC (high first); take top 5 to keep prompt bounded.
    const rank: Record<string, number> = { high: 3, medium: 2, low: 1 };
    findings.sort((x, y) => (rank[y.severity] ?? 0) - (rank[x.severity] ?? 0));
    const top = findings.slice(0, 5);
    const lines = top.map((f) => `  - [${f.severity}] ${f.a} vs ${f.b}${f.axis ? ' — ' + f.axis : ''}`);
    return [
      '',
      'PRIOR DETECTED CONTRADICTIONS (latest probe run, severity DESC, top 5):',
      ...lines,
      '',
      'If your synthesis writes to any of these slugs, reconcile the contradiction',
      'in the compiled_truth instead of recreating it. Either update to the newer/',
      'correct value, mark the older claim as historical, or note the conflict',
      'explicitly. Ignore findings irrelevant to what this transcript covers.',
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * Build the advisory TRIAGE MAP block spliced into the synthesis prompt
 * (#4152). Returns '' for legacy/degraded verdicts (score null) so the prompt
 * stays byte-identical to the pre-cascade shape in that case. Bounded to
 * ~2.5KB (≤8 segments × ≤300-char quotes + ≤12 entities) — rides inside the
 * existing 10% context headroom (HEADROOM_RATIO), no chunk-budget change.
 *
 * Chunked transcripts: segments whose normalized 60-char quote prefix appears
 * in this chunk's text are kept; the rest are dropped, and a caveat line notes
 * that segments came from a bounded sample of the full transcript. The block
 * is advisory, never load-bearing — the subagent is told to verify quotes
 * against the transcript text.
 */
export function buildTriageMapBlock(
  v: Pick<DreamVerdict, 'score' | 'content_type' | 'segments' | 'entities'> | undefined,
  chunkText: string,
  chunkTotal: number,
): string {
  if (!v || v.score === null) return '';
  // Presence check applies to EVERY chunk count (security review, #4152): a
  // segment whose quote prefix doesn't appear in the text it claims to quote
  // is fabricated judge output — drop it rather than trust it. For a
  // single-chunk transcript chunkText IS the full content, so verbatim quotes
  // always survive.
  // Shared grounding normalizer (F1b/F2 DRY): case + curly-quote + dash
  // folding on TOP of whitespace collapse — a segment the judge case-shifted
  // still verifies, while fabricated output still can't match.
  const normChunk = normForGrounding(chunkText);
  const segments = (v.segments ?? []).filter(s => {
    const prefix = normForGrounding(s.quote).slice(0, 60);
    return prefix.length > 0 && normChunk.includes(prefix);
  }).slice(0, 8);
  const lines: string[] = [
    '',
    'TRIAGE MAP (advisory pre-scan of this transcript by a cheap model — verify against the transcript text; ignore anything that does not match):',
    `- signal score: ${v.score.toFixed(2)}${v.content_type ? ` | content type: ${v.content_type}` : ''}`,
  ];
  if ((v.entities ?? []).length > 0) {
    lines.push(`- entity candidates: ${v.entities.slice(0, 12).join(', ')}`);
  }
  if (segments.length > 0) {
    lines.push('- candidate segments:');
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      lines.push(`  ${i + 1}. "${s.quote.slice(0, 300)}"${s.note ? ` — ${s.note.slice(0, 200)}` : ''}`);
    }
  }
  if (chunkTotal > 1) {
    lines.push('(Segments were identified from a bounded sample of the full transcript and may fall outside this chunk.)');
  }
  lines.push('Work from the candidate segments first — verify each against the transcript text below instead of re-scanning from scratch.');
  return '\n' + lines.join('\n');
}

function buildSynthesisPrompt(
  t: DiscoveredTranscript,
  chunkText: string,
  chunkIdx: number,
  chunkTotal: number,
  priorContradictionsBlock = '',
  outputRoot = 'wiki',
  triageMapBlock = '',
  linkManifestBlock = '',
  allowedSlugPrefixes: string[] = [],
  // #4117: per-lane namespaces. Defaults derive from outputRoot so existing
  // callers/tests are byte-identical; loadSynthConfig passes the validated
  // config-resolved values.
  reflectionsPrefix = `${outputRoot}/personal/reflections`,
  originalsPrefix = `${outputRoot}/originals/ideas`,
): string {
  // #4348: UTC projection retained here on purpose — this is a slug-name
  // hint for undated sources, not calendar provenance.
  const dateHint = t.inferredDate ?? utcDate();
  const baseSlugSegment = sanitizeForSlug(t.basename) || `session-${dateHint}`;
  const isChunked = chunkTotal > 1;
  const hashSuffix = isChunked
    ? `${t.contentHash.slice(0, 6)}-c${chunkIdx}`
    : t.contentHash.slice(0, 6);
  const chunkBanner = isChunked
    ? `\n- This is CHUNK ${chunkIdx + 1} of ${chunkTotal} from the same transcript. Different chunks process different sections; do not assume continuity with other chunks.`
    : '';
  const transcriptHeader = isChunked
    ? `${t.filePath} (chunk ${chunkIdx + 1}/${chunkTotal})`
    : t.filePath;
  // #4216 rule-2 wording: with a manifest present, the model is pointed at the
  // pre-resolved candidates FIRST (the search tool stays available on the
  // agentic path; the oneshot path has no tools, and this same prompt must be
  // byte-identical across a oneshot attempt and its agentic fallback).
  const crossRefRule = linkManifestBlock
    ? 'Cross-reference compulsively: every new page MUST contain at least one wikilink (e.g., `[ref](people/jane-doe)` or `[[people/jane-doe]]`) to existing brain content. Pick targets from the LINK CANDIDATES above (or another page you write in this response); use the search tool, if available, only when no candidate fits.'
    : 'Cross-reference compulsively: every new page MUST contain at least one wikilink (e.g., `[ref](people/jane-doe)` or `[[people/jane-doe]]`) to existing brain content. Use the search tool to find existing pages first.';
  // OV-7: the write allow-list must live in the PROMPT, not only in the
  // put_page tool schema — the oneshot path never sees a tool schema.
  const allowedPathsBlock = allowedSlugPrefixes.length > 0
    ? `\n\nALLOWED WRITE PATHS (writes outside these are rejected)\n${allowedSlugPrefixes.map(p => `- ${p}`).join('\n')}`
    : '';
  return `You are synthesizing a conversation transcript into the user's personal knowledge brain.

CONTEXT
- Today's date: ${dateHint}
- Transcript hash suffix (USE THIS in slugs): ${hashSuffix}
- Source file basename: ${baseSlugSegment}${chunkBanner}${priorContradictionsBlock}${triageMapBlock}${linkManifestBlock}${allowedPathsBlock}

OUTPUT POLICY (ALL of these are required)
1. Quote the user verbatim. Quotation marks are ONLY for spans reproducible EXACTLY from the transcript below — if you cannot reproduce a span exactly, paraphrase it WITHOUT quotation marks. Do not paraphrase memorable phrasings you can quote exactly.
2. ${crossRefRule}
3. Do NOT write to any path outside the ALLOWED WRITE PATHS above${allowedSlugPrefixes.length > 0 ? '' : ' (shown in the put_page schema)'}.
4. Slug discipline: lowercase alphanumeric and hyphens only, slash-separated segments. NO underscores, NO file extensions.
5. Self-contained opening: begin every new page's body with a 2-3 sentence summary that a reader unfamiliar with this transcript could understand on its own, before any quotes or detail. Do not assume the reader has the source conversation for context.
6. Preserve concrete facts: carry the specific numbers, dates, dollar amounts, names, and who-decided-what OF the salient content you write about, exactly as the transcript states them. Do not add routine logistics for their own sake.
7. Ground every claim in the transcript. Attribute speculation as speculation ("the user wondered whether..."), and never state a completion state or outcome the transcript does not show.

TASKS
A. Reflections (self-knowledge, pattern recognition, emotional processing):
   slug: \`${reflectionsPrefix}/${dateHint}-<topic-slug>-${hashSuffix}\`

B. Originals (new ideas, frames, theses, mental models):
   slug: \`${originalsPrefix}/${dateHint}-<idea-slug>-${hashSuffix}\`

C. People mentions: ${linkManifestBlock ? 'check LINK CANDIDATES (and the search tool, when available) first' : 'search first, when a search tool is available'}; never write over an existing person page (the orchestrator handles people enrichment via timeline entries — your job is the reflection/original synthesis, NOT modifying existing person pages).

D. If nothing in this transcript meets the bar (significance filter already passed but the content is still routine), return without writing anything.

TRANSCRIPT (${transcriptHeader})
---
${chunkText}
---

When done, briefly list the slugs you wrote in your final message so the orchestrator can audit.`;
}

function sanitizeForSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ── Slug collection from child put_page calls (codex #2 + D6) ────────

/**
 * D6 (orchestrator-side deterministic slug rewrite, zero Sonnet trust):
 * two-stage path — raw fetch (no DISTINCT, preserves duplicate evidence) →
 * in-memory chunk-suffix rewrite via `rewriteChunkedSlug` for chunked
 * children → return distinct rewritten set.
 *
 * Closes Codex finding #2 ("collision detection via SELECT DISTINCT was
 * fake"): we no longer need detection because the rewrite enforces
 * uniqueness at slug-write time.
 *
 * `chunkInfo` maps child job_id → { chunk_index, hash6 }. Single-chunk
 * children are absent from the map and pass through unchanged.
 */
async function collectChildPutPageSlugs(
  engine: BrainEngine,
  childIds: number[],
  chunkInfo: Map<number, { idx: number; hash6: string }>,
  sourceId = 'default',
  jobRawSource?: Map<number, string>,
  // F6 out-param (backwards-compatible with the __testing call sites):
  // collects the job ids that produced ≥1 put_page write, so the caller can
  // count zero-page children without a second subagent_tool_executions scan.
  outJobsWithPages?: Set<number>,
): Promise<Array<{ slug: string; source_id: string; raw_source?: string }>> {
  if (childIds.length === 0) return [];
  // Raw fetch — NO SELECT DISTINCT. Preserves per-child slug duplicates so
  // the orchestrator sees what each child wrote. COALESCE handles both
  // properly-stored jsonb objects (input->>'slug') and double-encoded jsonb
  // strings from pre-fix data ((input #>> '{}')::jsonb->>'slug').
  //
  // v0.32.8: returns Array<{slug, source_id}> instead of string[]. Subagent
  // put_page tool schema doesn't expose source_id (subagents are scoped to
  // a single source). #1586: the orchestrator scopes each child to the
  // cycle's resolved source via SubagentHandlerData.source_id, and stamps
  // the SAME source here so reverseWriteRefs / provenance reads target the
  // correct (source_id, slug) row. Unset → legacy 'default'.
  const rows = await engine.executeRaw<{ job_id: number | bigint; slug: string }>(
    `SELECT job_id,
            COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[])
        AND tool_name = 'brain_put_page'
        AND status = 'complete'`,
    [childIds],
  );
  // #1978: slug → source transcript path (first writer wins) so the
  // provenance stamp can record WHERE the synthesized content came from.
  const rewritten = new Map<string, string | undefined>();
  for (const r of rows) {
    if (typeof r.slug !== 'string' || r.slug.length === 0) continue;
    // Postgres decodes the BIGINT FK as bigint; both metadata maps are keyed
    // by the INTEGER minion job id represented as a JavaScript number.
    const jobId = Number(r.job_id);
    outJobsWithPages?.add(jobId);
    const ci = chunkInfo.get(jobId);
    const slug = ci ? rewriteChunkedSlug(r.slug, ci.hash6, ci.idx) : r.slug;
    if (!rewritten.has(slug) || rewritten.get(slug) === undefined) {
      rewritten.set(slug, jobRawSource?.get(jobId));
    }
  }
  return Array.from(rewritten.keys()).sort().map(slug => {
    const raw_source = rewritten.get(slug);
    return { slug, source_id: sourceId, ...(raw_source ? { raw_source } : {}) };
  });
}

/**
 * D8: load every `completed` legacy job key in the pre-v2 path-based
 * family `dream:synth:<filePath>:<hash16>[:c<i>of<n>]`. Used at fan-out
 * time to detect transcripts already synthesized under an old key shape;
 * those should NOT be re-submitted under v2 keys. (v2 keys start with
 * `dream:synth-v2:` and don't match the LIKE prefix — the queue's own
 * idempotency dedupe already covers them.)
 *
 * Plain `status = 'completed'` deliberately mirrors the queue-level
 * idempotency semantics the legacy keys relied on: a completed job blocks
 * re-submission regardless of `result.stop_reason` (pinned in
 * test/minions.test.ts). Filtering on stop_reason here would re-pay for
 * transcripts the old code path never re-ran, and reading `result` at all
 * would need the `(result #>> '{}')` double-encoded-jsonb defense.
 *
 * Loads source-scoped completions once per phase; no schema additions
 * and no repeated history scan for each transcript.
 */
async function loadSuccessfulLegacySynthesisKeys(
  engine: BrainEngine,
  sourceId: string,
): Promise<string[]> {
  const rows = await engine.executeRaw<{ idempotency_key: string }>(
    `SELECT idempotency_key
       FROM minion_jobs
      WHERE name = 'subagent'
        AND status = 'completed'
        AND COALESCE(NULLIF(data->>'source_id', ''), 'default') = $1
        AND idempotency_key LIKE 'dream:synth:%'`,
    [sourceId],
  );
  return rows.map(row => row.idempotency_key);
}

/**
 * Match a transcript (by filename + content hash) against completed legacy
 * keys. `'single'` when a `dream:synth:<path>:<hash16>` completion exists;
 * `'chunked'` when a FULL chunk set `:c0of<n>`..`:c<n-1>of<n>` completed
 * (chunk indices are 0-based). Partial chunk sets return null so the
 * transcript gets a fresh v2 synthesis instead of shipping with holes.
 */
function findLegacyCompletion(
  successfulKeys: string[],
  filePath: string,
  hash16: string,
): 'single' | 'chunked' | null {
  const filename = basename(filePath);
  const hashSuffix = `:${hash16}`;
  /** total chunk count n → completed 0-based chunk indices */
  const chunkSets = new Map<number, Set<number>>();
  for (const key of successfulKeys) {
    const chunk = /:c(\d+)of(\d+)$/.exec(key);
    const base = chunk ? key.slice(0, -chunk[0].length) : key;
    if (!base.endsWith(hashSuffix)) continue;
    const historicalPath = base.slice('dream:synth:'.length, -hashSuffix.length);
    if (basename(historicalPath) !== filename) continue;
    if (!chunk) return 'single';
    const i = Number(chunk[1]);
    const n = Number(chunk[2]);
    if (n < 1 || i < 0 || i >= n) continue;
    let seen = chunkSets.get(n);
    if (!seen) chunkSets.set(n, seen = new Set());
    seen.add(i);
  }
  for (const [n, seen] of chunkSets) {
    if (seen.size === n) return 'chunked';
  }
  return null;
}

// ── Dream-provenance DB stamp (#2569) ────────────────────────────────

/**
 * Persist the dream-output identity marker (`dream_generated: true` +
 * `dream_cycle_date`) into the `pages.frontmatter` JSONB row for every page
 * a synthesize child wrote. Render-time `frontmatterOverrides` alone only
 * reach the markdown FILE — the DB row stayed unstamped, so DB consumers
 * couldn't enumerate generated pages and a later put_page write-through
 * (which re-renders from the DB row) silently erased the marker.
 *
 * Plain UPDATE through executeRawJsonb (raw object bound to $4::jsonb —
 * never JSON.stringify into a ::jsonb cast; engine-parity safe, no new
 * engine method). Best-effort per row: a stamp failure never kills the
 * phase (the render-time override still covers the file).
 *
 * #4337: reruns preserve the FIRST dream cycle date. `dream_cycle_date`
 * stays the stable back-compat query key and `dream_created_cycle_date`
 * is its explicit immutable mirror — an existing value of either (created
 * mirror wins) beats this run's cycleDate, so a re-synthesis pass can't
 * rewrite a page's provenance to the maintenance run's date.
 */
async function stampDreamProvenance(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string; raw_source?: string }>,
  cycleDate: string,
  signal?: AbortSignal,
): Promise<void> {
  if (refs.length === 0) return;
  const { executeRawJsonb } = await import('../sql-query.ts');
  for (const { slug, source_id, raw_source } of refs) {
    // #4077: per-row abort check — the per-row try below is only for stamp
    // failures and must not swallow the cancellation unwind.
    throwIfAborted(signal, '[dream] synthesize provenance');
    try {
      await executeRawJsonb(
        engine,
        `UPDATE pages
            SET frontmatter = COALESCE(frontmatter, '{}'::jsonb)
                              || $4::jsonb
                              || jsonb_build_object(
                                   'dream_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3),
                                   'dream_created_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3)
                                 )
          WHERE slug = $1 AND source_id = $2`,
        [slug, source_id, cycleDate],
        // #1978 raw-source persistence: record the transcript path the
        // synthesis was derived from, so `gbrain doctor` (raw_provenance
        // check) can verify every generated page carries a raw trace.
        [{
          dream_generated: true,
          ...(raw_source ? { raw_source } : {}),
        }],
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] provenance stamp ${slug}@${source_id} failed: ${msg}\n`);
    }
  }
}

// ── Reverse-write DB rows → markdown files ───────────────────────────

async function reverseWriteRefs(
  engine: BrainEngine,
  brainDir: string,
  refs: Array<{ slug: string; source_id: string }>,
  nativeSourceId = 'default',
  signal?: AbortSignal,
): Promise<number> {
  let count = 0;
  for (const { slug, source_id } of refs) {
    throwIfAborted(signal, '[dream] synthesize reverse-write');
    // v0.32.8 F6: validate source_id is filesystem-safe before any join().
    validateSourceId(source_id);
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    const tags = await engine.getTags(slug, { sourceId: source_id });
    // #4077: re-check after the row reads — an abort that lands during
    // getPage/getTags must not reach this ref's file write.
    throwIfAborted(signal, '[dream] synthesize reverse-write');
    try {
      const md = renderPageToMarkdown(page, tags);
      // v0.32.8 F6: foreign-source pages land at brainDir/.sources/<id>/<slug>.md
      // so same-slug-different-source pages don't collide. Pages belonging to
      // the cycle's own source (#1586: brainDir IS that source's checkout —
      // legacy 'default' when unscoped) stay at brainDir/<slug>.md.
      const filePath = source_id === nativeSourceId
        ? join(brainDir, `${slug}.md`)
        : join(brainDir, '.sources', source_id, `${slug}.md`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, md, 'utf8');
      count++;
    } catch (e) {
      // Per-slug failures are non-fatal — phase continues.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] reverse-write ${slug}@${source_id} failed: ${msg}\n`);
    }
  }
  return count;
}

/**
 * Render a Page to markdown, stamping the dream-output identity marker into
 * frontmatter. This stamp is the explicit identity surface checked by
 * `isDreamOutput` in transcript-discovery.ts. Stamping at render time covers
 * every reverse-write path (subagent reflections + originals + summary) with
 * one funnel; the prior content-pattern guard could miss real output because
 * `serializeMarkdown` does not embed the page slug in the body.
 */
export function renderPageToMarkdown(page: Page, tags: string[]): string {
  // v0.38 DRY: the dream-output identity stamp (dream_generated +
  // dream_cycle_date) is the ONLY thing that differs from the v0.38
  // put_page write-through renderer. Both call the shared
  // serializePageToMarkdown helper in markdown.ts; this wrapper passes
  // the dream-specific overrides. Future markdown-shape changes happen
  // in one place.
  //
  // #4337: preserve the DB-stamped first cycle date (stampDreamProvenance
  // runs before the reverse-write). Falling back to utcDate() is only for
  // legacy callers rendering an unstamped page for the first time — the
  // pre-fix today() default rewrote every rerendered page's provenance to
  // the maintenance run's date.
  const createdCycleDate = page.frontmatter?.dream_created_cycle_date;
  const legacyCycleDate = page.frontmatter?.dream_cycle_date;
  const stableCycleDate = typeof createdCycleDate === 'string' && createdCycleDate
    ? createdCycleDate
    : typeof legacyCycleDate === 'string' && legacyCycleDate
      ? legacyCycleDate
      : utcDate();
  return serializePageToMarkdown(page, tags, {
    frontmatterOverrides: {
      dream_generated: true,
      dream_cycle_date: stableCycleDate,
      dream_created_cycle_date: stableCycleDate,
    },
  });
}

// ── Summary index page ───────────────────────────────────────────────

/**
 * #4337: cap the summary's wikilink list. An unbounded list turned the
 * summary into a graph hub (thousands of edges on a large cycle) and an
 * oversized file, even though every child already carries queryable
 * provenance (`dream_generated` + `dream_cycle_date` frontmatter).
 */
const SUMMARY_LINK_SAMPLE_LIMIT = 20;

async function writeSummaryPage(
  engine: BrainEngine,
  brainDir: string,
  summarySlug: string,
  summaryDate: string,
  writtenSlugs: string[],
  childOutcomes: Array<{ jobId: number; status: string }>,
  sourceId = 'default',
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, '[dream] synthesize summary');
  const completed = childOutcomes.filter(c => c.status === 'completed').length;
  const failed = childOutcomes.length - completed;

  const lines: string[] = [];
  lines.push(`# Dream cycle ${summaryDate}`);
  lines.push('');
  lines.push(`**Children:** ${completed} completed, ${failed} failed/timeout.`);
  lines.push(`**Pages written:** ${writtenSlugs.length}.`);
  lines.push('');
  if (writtenSlugs.length > 0) {
    // #4337: deterministic, lexicographically sorted sample — small cycles
    // stay fully linked; large cycles list exactly SUMMARY_LINK_SAMPLE_LIMIT
    // links while keeping exact totals above. The full child set stays
    // recoverable via per-page provenance frontmatter (pointer below).
    const sampledSlugs = [...writtenSlugs].sort().slice(0, SUMMARY_LINK_SAMPLE_LIMIT);
    lines.push(
      writtenSlugs.length > SUMMARY_LINK_SAMPLE_LIMIT
        ? `## Page sample (${sampledSlugs.length} of ${writtenSlugs.length})`
        : '## Pages',
      '',
      ...sampledSlugs.map(slug => `- [[${slug}]]`),
      '',
    );
    if (writtenSlugs.length > SUMMARY_LINK_SAMPLE_LIMIT) {
      lines.push(
        '## Full output provenance',
        '',
        `The complete ${writtenSlugs.length}-page set is recoverable in this source by querying page frontmatter for ` +
          `\`dream_generated: true\` and \`dream_cycle_date: ${summaryDate}\`, excluding \`${summarySlug}\`. ` +
          'Every child page carries those provenance fields; this summary intentionally links only the deterministic sample above.',
        '',
      );
    }
  }

  const body = lines.join('\n');
  // Stamp the dream-output identity marker into the summary's frontmatter.
  // parseMarkdown below round-trips it into the DB-stored frontmatter, so the
  // marker survives any later reverse-render of the summary page.
  const fullMarkdown = serializeMarkdown(
    {
      dream_generated: true,
      dream_cycle_date: summaryDate,
      // #4337: immutable mirror — reruns preserve the first cycle date via
      // stampDreamProvenance/renderPageToMarkdown; the summary is per-date so
      // both keys are simply the summary's own date.
      dream_created_cycle_date: summaryDate,
      // #1978: deterministic index page — no source document of its own;
      // raw traces live on the listed pages. Explicit exemption keeps the
      // doctor raw_provenance check quiet.
      raw_trace_exempt: true,
      raw_trace_exempt_reason: 'deterministic dream-cycle index; raw traces live on listed pages',
    } as Record<string, unknown>,
    body,
    '',
    { type: 'note' as string, title: `Dream cycle ${summaryDate}`, tags: ['dream-cycle'] },
  );

  // Direct engine.putPage — orchestrator write, no subagent context, no
  // allow-list check (server-side viaSubagent=false). The summary slug is
  // pre-validated against SUMMARY_SLUG_RE in the caller.
  // Importing put_page via operations.ts would re-run namespace logic
  // unnecessarily; we go straight to the engine.
  const { parseMarkdown } = await import('../markdown.ts');
  const parsed = parseMarkdown(fullMarkdown);
  // #1586: summary lands in the cycle's resolved source too — otherwise the
  // children live in the named source while the index drifts to 'default'.
  await engine.putPage(summarySlug, {
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
  }, { sourceId });

  // Also write to disk (orchestrator dual-write). #4506: the unconditional
  // file write dirtied clean source repos (an untracked
  // dream-cycle-summaries/<date>.md after every nightly run). Two
  // suppressors, both leaving the DB row untouched:
  //   - explicit knob `dream.synthesize.summary_file_write=false|0|off`
  //     (default ON — back-compat for brains that expect the dual-write);
  //   - a gbrain.yml storage tier that declares the summary slug `db_only`
  //     (the DB/file-plane split the reporter expected to cover this path).
  const fileWriteRaw = (await engine.getConfig('dream.synthesize.summary_file_write'))?.trim().toLowerCase();
  const fileWriteEnabled = !(fileWriteRaw === 'false' || fileWriteRaw === '0' || fileWriteRaw === 'off');
  let dbOnlyTier = false;
  if (fileWriteEnabled) {
    try {
      const storage = loadStorageConfig(brainDir);
      dbOnlyTier = storage !== null && isDbOnly(summarySlug, storage);
    } catch {
      // Unreadable gbrain.yml — keep the dual-write default (fail-open to
      // pre-#4506 behavior; sync owns loud storage-config validation).
    }
  }
  if (!fileWriteEnabled || dbOnlyTier) {
    const why = !fileWriteEnabled ? 'dream.synthesize.summary_file_write=off' : 'db_only storage tier';
    process.stderr.write(`[dream] summary file-write skipped (${why}): ${summarySlug} lives in the DB only\n`);
    return;
  }
  try {
    const filePath = join(brainDir, `${summarySlug}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, fullMarkdown, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[dream] summary file-write failed: ${msg}\n`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function loadAdHocTranscript(
  filePath: string,
  minChars: number,
  excludePatterns: string[],
  bypassGuard?: boolean,
): DiscoveredTranscript[] {
  const { readSingleTranscript } = require('./transcript-discovery.ts') as typeof import('./transcript-discovery.ts');
  const t = readSingleTranscript(filePath, { minChars, excludePatterns, bypassGuard });
  return t ? [t] : [];
}

function ok(summary: string, details: Record<string, unknown> = {}): PhaseResult {
  return { phase: 'synthesize', status: 'ok', duration_ms: 0, summary, details };
}

function skipped(reason: string, summary: string): PhaseResult {
  return {
    phase: 'synthesize',
    status: 'skipped',
    duration_ms: 0,
    summary,
    details: { reason },
  };
}

function failed(error: PhaseError, details: Record<string, unknown> = {}): PhaseResult {
  return {
    phase: 'synthesize',
    status: 'fail',
    duration_ms: 0,
    summary: 'synthesize phase failed',
    details,
    error,
  };
}

function makeError(cls: string, code: string, message: string, hint?: string): PhaseError {
  return hint ? { class: cls, code, message, hint } : { class: cls, code, message };
}

// ── Test-only export ───────────────────────────────────────
// `__testing` re-exports otherwise-private helpers so unit tests can pin
// behavior at function granularity (e.g., #745 collectChildPutPageSlugs
// double-encoded jsonb regression). Not part of the runtime contract.
export const __testing = {
  collectChildPutPageSlugs,
  buildSynthesisPrompt,
  buildDreamSummarySlug,
  stampDreamProvenance,
  reverseWriteRefs,
  runSubagentsInline,
  loadSynthConfig,
  writeSummaryPage,
  priceChatUsd,
};
