/**
 * Synthesize phase (v0.23) — conversation-to-brain pipeline.
 *
 * Reads transcripts from the configured corpus dir, runs a cheap Haiku
 * "is this worth processing?" verdict (cached in `dream_verdicts`), then
 * fans out one Sonnet subagent per worth-processing transcript with the
 * trusted-workspace `allowed_slug_prefixes` list. After children resolve,
 * the orchestrator queries `subagent_tool_executions` for the put_page
 * slugs each child wrote (codex finding #2: NOT a time-windowed pages
 * query — picks up unrelated writes), reverse-renders each new page from
 * DB to disk, and writes a deterministic summary index.
 *
 * Hard guarantees:
 *   - Subagent never gets fs-write access. Orchestrator holds the dual-write.
 *   - Allow-list is sourced from `skills/_brain-filing-rules.json` (single
 *     source of truth) and threaded as handler data; PROTECTED_JOB_NAMES
 *     prevents MCP from submitting `subagent` jobs, so the field is trusted.
 *   - Cooldown via `dream.synthesize.last_completion_ts` config key —
 *     written ONLY on success (codex finding #5 deferral: no auto git commit
 *     in v1).
 *   - Idempotency via `dream:synth:<file_path>:<content_hash>` job key.
 *   - Edited transcripts produce slugs with content-hash suffix → no overwrite.
 *
 * NOT in v1:
 *   - git auto-commit / push (deferred to v1.1, codex finding #5).
 *   - Daily token budget cap (cooldown bounds spend at v1 scale).
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult, PhaseError } from '../cycle.ts';
import { MinionQueue } from '../minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionJobInput, SubagentHandlerData } from '../minions/types.ts';
import { discoverTranscripts, type DiscoveredTranscript } from './transcript-discovery.ts';
import { serializeMarkdown } from '../markdown.ts';
import type { Page, PageType } from '../types.ts';

// Slug regex from validatePageSlug — kept in sync.
// Used for the orchestrator-written summary index slug.
const SUMMARY_SLUG_RE = /^[a-z0-9][a-z0-9\-]*(\/[a-z0-9][a-z0-9\-]*)*$/;

// ── Model context budget (D1, D5, D7, D9) ─────────────────────────────

/**
 * Anthropic model id → input context window (tokens).
 * Unknown id (non-Anthropic alias, custom string) → safe 200K-token fallback
 * via `computeChunkCharBudget`. Codex finding #4: `resolveModel()` does not
 * canonicalize to Anthropic-only; this map keys on the exact strings the
 * resolver returns for known Anthropic aliases.
 */
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
};

/** Token-to-char ratio. 3.5 matches PR #748; conservative for English text. */
const CHARS_PER_TOKEN = 3.5;
/** Reserve 10% of context window for system prompt + tool defs + output. */
const HEADROOM_RATIO = 0.9;
/** Floor on user-overridable max_prompt_tokens (matches PR #748 minimum). */
const MIN_PROMPT_TOKENS = 100_000;
/** Default chunk-count cap; operator-configurable via dream.synthesize.max_chunks_per_transcript. */
const DEFAULT_MAX_CHUNKS = 24;
/** Conservative default budget when model is unknown (200K × HEADROOM_RATIO). */
const UNKNOWN_MODEL_BUDGET_TOKENS = 180_000;

/**
 * Compute per-chunk character budget for the resolved model + config override.
 *
 * Resolution:
 *   - configMaxPromptTokens (already floored at MIN_PROMPT_TOKENS) wins when set.
 *   - Else the model's MODEL_CONTEXT_TOKENS entry × HEADROOM_RATIO.
 *   - Else (non-Anthropic alias / custom id) UNKNOWN_MODEL_BUDGET_TOKENS, with
 *     a once-per-process stderr warning.
 *
 * D7 scope: this bounds the INITIAL prompt size only. Tool-loop turn-N
 * accumulation is out of scope for v0.30.2 (terminal-error classification
 * catches turn-N blowups; per-turn budget guard is a v0.31+ follow-up).
 */
function computeChunkCharBudget(
  model: string,
  configMaxPromptTokens: number | null,
): number {
  if (configMaxPromptTokens !== null) {
    return Math.floor(configMaxPromptTokens * CHARS_PER_TOKEN);
  }
  const ctx = MODEL_CONTEXT_TOKENS[model];
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
    `[dream] model "${model}" is not in MODEL_CONTEXT_TOKENS; ` +
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
  return maxChars;
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
  /**
   * Disable the self-consumption guard. Wired from the
   * `--unsafe-bypass-dream-guard` CLI flag. NOT auto-applied for `--input`
   * because that would allow any dream-generated page to silently re-enter
   * the synthesize loop. Caller must opt in explicitly.
   */
  bypassDreamGuard?: boolean;
}

export async function runPhaseSynthesize(
  engine: BrainEngine,
  opts: SynthesizePhaseOpts,
): Promise<PhaseResult> {
  const start = Date.now();
  try {
    const config = await loadSynthConfig(engine);

    // Allow ad-hoc --input to run even when config is disabled.
    if (!opts.inputFile && !config.corpusDir) {
      return skipped('not_configured',
        'dream.synthesize.session_corpus_dir is unset');
    }
    if (!opts.inputFile && !config.enabled) {
      return skipped('not_configured',
        'dream.synthesize.enabled is explicitly false');
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

    // Significance verdicts (cached in dream_verdicts; Haiku on miss).
    const worthProcessing: DiscoveredTranscript[] = [];
    const verdicts: Array<{ filePath: string; worth: boolean; reasons: string[]; cached: boolean }> = [];
    const haiku = makeHaikuClient(); // null if no API key
    for (const t of transcripts) {
      const cached = await engine.getDreamVerdict(t.filePath, t.contentHash);
      if (cached) {
        verdicts.push({ filePath: t.filePath, worth: cached.worth_processing, reasons: cached.reasons, cached: true });
        if (cached.worth_processing) worthProcessing.push(t);
        continue;
      }
      if (!haiku) {
        // No API key — can't judge. Skip with explicit reason; don't crash phase.
        verdicts.push({ filePath: t.filePath, worth: false, reasons: ['no ANTHROPIC_API_KEY for significance judge'], cached: false });
        continue;
      }
      const verdict = await judgeSignificance(haiku, t, config.verdictModel);
      await engine.putDreamVerdict(t.filePath, t.contentHash, verdict);
      verdicts.push({ filePath: t.filePath, worth: verdict.worth_processing, reasons: verdict.reasons, cached: false });
      if (verdict.worth_processing) worthProcessing.push(t);
    }

    // Dry-run stops here: significance filter ran (Haiku verdicts cached),
    // but no Sonnet synthesis. Codex finding #8: --dry-run does NOT mean
    // "zero LLM calls"; it means "skip Sonnet."
    if (opts.dryRun) {
      return ok(`dry-run: ${worthProcessing.length} of ${transcripts.length} transcripts would synthesize`, {
        transcripts_discovered: transcripts.length,
        transcripts_processed: 0,
        pages_written: 0,
        verdicts,
        dryRun: true,
      });
    }

    if (worthProcessing.length === 0) {
      // Even with verdicts, the cooldown timestamp is updated only on a
      // real successful run — not on "nothing worth processing." Lets a
      // re-run pick up if a new transcript lands later.
      return ok('all transcripts skipped by significance filter', {
        transcripts_discovered: transcripts.length,
        transcripts_processed: 0,
        pages_written: 0,
        verdicts,
      });
    }

    // Fan-out: submit one subagent per worth-processing transcript (or one
    // per chunk for transcripts that exceed the model's per-prompt budget).
    const allowedSlugPrefixes = await loadAllowedSlugPrefixes();
    if (allowedSlugPrefixes.length === 0) {
      return failed(makeError('InternalError', 'NO_ALLOWLIST',
        'skills/_brain-filing-rules.json missing dream_synthesize_paths.globs'));
    }

    const queue = new MinionQueue(engine);
    const childIds: number[] = [];
    /** Map child job_id → chunk metadata for D6 orchestrator-side slug rewrite. */
    const chunkInfo = new Map<number, { idx: number; hash6: string }>();
    /** Skip reasons for the cycle report (D5 cap hits, D8 legacy-key skips). */
    const skipReports: Array<{ filePath: string; reason: string }> = [];

    const maxCharsPerChunk = computeChunkCharBudget(config.model, config.maxPromptTokens);

    for (const t of worthProcessing) {
      const hash16 = t.contentHash.slice(0, 16);
      const hash6 = t.contentHash.slice(0, 6);

      // D8: single→multi-chunk migration safety. If a completed legacy
      // single-chunk job exists for this content_hash, treat as already-
      // synthesized and skip. Prevents duplicate writes when a transcript
      // that was previously single-chunk now multi-chunks (because budget
      // shrank or model changed).
      if (await hasLegacySingleChunkCompletion(engine, t.filePath, hash16)) {
        skipReports.push({
          filePath: t.filePath,
          reason: 'already_synthesized_legacy_single_chunk',
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

      const isChunked = chunks.length > 1;
      for (let i = 0; i < chunks.length; i++) {
        const childData: SubagentHandlerData = {
          prompt: buildSynthesisPrompt(t, chunks[i], i, chunks.length),
          model: config.model,
          max_turns: 30,
          allowed_slug_prefixes: allowedSlugPrefixes,
        };
        // Idempotency key parity:
        //   - single-chunk → legacy `dream:synth:<filePath>:<hash16>` (byte-
        //     equivalent across versions; preserves dedup for unchanged
        //     transcripts on upgrade).
        //   - multi-chunk → `<legacy>:c<i>of<n>` per chunk; durable across
        //     runs because D9 splitTranscriptByBudget is hash-deterministic.
        const idempotency_key = isChunked
          ? `dream:synth:${t.filePath}:${hash16}:c${i}of${chunks.length}`
          : `dream:synth:${t.filePath}:${hash16}`;
        const submitOpts: Partial<MinionJobInput> = {
          max_stalled: 3,
          on_child_fail: 'continue',
          idempotency_key,
          timeout_ms: 30 * 60 * 1000, // 30 min per chunk
        };
        const child = await queue.add(
          'subagent',
          childData as unknown as Record<string, unknown>,
          submitOpts,
          { allowProtectedSubmit: true },
        );
        childIds.push(child.id);
        if (isChunked) {
          chunkInfo.set(child.id, { idx: i, hash6 });
        }
      }
    }

    // Wait for every child to reach a terminal state. Tick yieldDuringPhase
    // every 5 min so the cycle lock TTL refreshes.
    const childOutcomes: Array<{ jobId: number; status: string }> = [];
    for (const jobId of childIds) {
      try {
        const job = await waitForCompletion(queue, jobId, {
          timeoutMs: 35 * 60 * 1000,
          pollMs: 5 * 1000,
        });
        childOutcomes.push({ jobId, status: job.status });
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
    const writtenSlugs = await collectChildPutPageSlugs(engine, childIds, chunkInfo);

    // Dual-write: reverse-render each DB row → markdown file.
    const reverseWriteCount = await reverseWriteSlugs(engine, opts.brainDir, writtenSlugs);

    // Summary index page (deterministic; orchestrator-written via direct
    // engine.putPage so no allow-list path needed).
    const summaryDate = opts.date ?? today();
    const summarySlug = `dream-cycle-summaries/${summaryDate}`;
    if (SUMMARY_SLUG_RE.test(summarySlug)) {
      await writeSummaryPage(engine, opts.brainDir, summarySlug, summaryDate, writtenSlugs, childOutcomes);
    }

    // Write completion timestamp ON SUCCESS only.
    await engine.setConfig('dream.synthesize.last_completion_ts', new Date().toISOString());

    const ms = Date.now() - start;
    const submittedTranscripts = worthProcessing.length - skipReports.length;
    return ok(`${submittedTranscripts} transcript(s) synthesized in ${(ms / 1000).toFixed(1)}s`, {
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
      // D5 cap hits + D8 legacy-key skips. Empty when nothing skipped.
      skips: skipReports,
      summary_slug: summarySlug,
      verdicts,
    });
  } catch (e) {
    return failed(makeError('InternalError', 'SYNTH_PHASE_FAIL',
      e instanceof Error ? (e.message || 'synthesize phase threw') : String(e)));
  }
}

// ── Config ────────────────────────────────────────────────────────────

interface SynthConfig {
  enabled: boolean;
  corpusDir: string | null;
  meetingTranscriptsDir: string | null;
  minChars: number;
  excludePatterns: string[];
  model: string;
  verdictModel: string;
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
}

async function loadSynthConfig(engine: BrainEngine): Promise<SynthConfig> {
  const enabledRaw = await engine.getConfig('dream.synthesize.enabled');
  const corpusDir = await engine.getConfig('dream.synthesize.session_corpus_dir');
  // v2: enabled defaults to true when corpus dir is configured, false otherwise.
  // Explicit enabled=false still wins for pausing synthesis without removing corpus config.
  const enabled = enabledRaw === 'false' ? false : (enabledRaw === 'true' || !!corpusDir);
  const meetingTranscriptsDir = await engine.getConfig('dream.synthesize.meeting_transcripts_dir');
  const minCharsStr = await engine.getConfig('dream.synthesize.min_chars');
  const excludeStr = await engine.getConfig('dream.synthesize.exclude_patterns');
  // v0.28: resolveModel() unifies CLI flag > new key > deprecated key > models.default > env > fallback
  const { resolveModel } = await import('../model-config.ts');
  const model = await resolveModel(engine, {
    configKey: 'models.dream.synthesize',
    deprecatedConfigKey: 'dream.synthesize.model',
    fallback: 'sonnet',
  });
  const verdictModel = await resolveModel(engine, {
    configKey: 'models.dream.synthesize_verdict',
    deprecatedConfigKey: 'dream.synthesize.verdict_model',
    fallback: 'haiku',
  });
  const cooldownHoursStr = await engine.getConfig('dream.synthesize.cooldown_hours');
  const maxPromptTokensStr = await engine.getConfig('dream.synthesize.max_prompt_tokens');
  const maxChunksStr = await engine.getConfig('dream.synthesize.max_chunks_per_transcript');

  let excludePatterns: string[] = ['medical', 'therapy'];
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

  return {
    enabled,
    corpusDir: corpusDir ?? null,
    meetingTranscriptsDir: meetingTranscriptsDir ?? null,
    minChars: minCharsStr ? Math.max(0, parseInt(minCharsStr, 10) || 2000) : 2000,
    excludePatterns,
    model,
    verdictModel,
    cooldownHours: cooldownHoursStr ? Math.max(0, parseInt(cooldownHoursStr, 10) || 12) : 12,
    maxPromptTokens,
    maxChunksPerTranscript,
  };
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

async function loadAllowedSlugPrefixes(): Promise<string[]> {
  // Search a few known locations relative to the binary / repo. The first
  // hit wins; if none found, return [].
  const candidates = [
    join(process.cwd(), 'skills', '_brain-filing-rules.json'),
    join(__dirname, '..', '..', '..', 'skills', '_brain-filing-rules.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { dream_synthesize_paths?: { globs?: unknown } };
      const globs = parsed?.dream_synthesize_paths?.globs;
      if (Array.isArray(globs) && globs.every(g => typeof g === 'string')) {
        return globs as string[];
      }
    } catch { /* try next */ }
  }
  return [];
}

// ── Significance judge (Haiku) ───────────────────────────────────────

export interface JudgeClient {
  create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
}

function makeHaikuClient(): JudgeClient | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return { create: client.messages.create.bind(client.messages) };
}

interface VerdictResult {
  worth_processing: boolean;
  reasons: string[];
}

export async function judgeSignificance(
  client: JudgeClient,
  t: DiscoveredTranscript,
  verdictModel = 'claude-haiku-4-5-20251001',
): Promise<VerdictResult> {
  // Truncate the transcript at 8K chars for cost control. Haiku's verdict
  // doesn't need the full body; the opening + closing sections are usually
  // representative of significance.
  const trimmed = t.content.length > 8000
    ? t.content.slice(0, 4000) + '\n[...truncated...]\n' + t.content.slice(-4000)
    : t.content;

  const sys = `You judge whether a conversation transcript is worth synthesizing into a personal knowledge brain.

WORTH PROCESSING (return worth_processing=true):
- The user articulates a new idea, frame, mental model, or thesis
- The user reflects on themselves, names patterns, processes emotion
- The user discusses specific people, companies, or decisions in depth
- The user makes a strategic call worth remembering

NOT WORTH PROCESSING (return worth_processing=false):
- Routine ops ("check my email", "schedule X")
- Pure code debugging without user reflection
- Short message exchanges with no original thought
- Repetitive content the brain already has

Respond as JSON: {"worth_processing": <bool>, "reasons": ["<short>", "<short>"]}.
Two reasons max, one phrase each.`;

  const msg = await client.create({
    model: verdictModel,
    max_tokens: 200,
    system: sys,
    messages: [{ role: 'user', content: `Transcript ${t.basename}:\n\n${trimmed}` }],
  });

  for (const block of msg.content) {
    if (block.type === 'text') {
      const text = block.text.trim();
      const m = /\{[\s\S]*\}/.exec(text);
      if (!m) continue;
      try {
        const parsed = JSON.parse(m[0]) as { worth_processing?: unknown; reasons?: unknown };
        const worth = parsed.worth_processing === true;
        const reasons = Array.isArray(parsed.reasons)
          ? parsed.reasons.filter((r): r is string => typeof r === 'string').slice(0, 4)
          : [];
        return { worth_processing: worth, reasons };
      } catch { /* fall through */ }
    }
  }
  // Couldn't parse — default to NOT processing (cheap fallback).
  return { worth_processing: false, reasons: ['judge response unparseable'] };
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
function buildSynthesisPrompt(
  t: DiscoveredTranscript,
  chunkText: string,
  chunkIdx: number,
  chunkTotal: number,
): string {
  const dateHint = t.inferredDate ?? today();
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
  return `You are synthesizing a conversation transcript into the user's personal knowledge brain.

CONTEXT
- Today's date: ${dateHint}
- Transcript hash suffix (USE THIS in slugs): ${hashSuffix}
- Source file basename: ${baseSlugSegment}${chunkBanner}

OUTPUT POLICY (ALL of these are required)
1. Quote the user verbatim. Do not paraphrase memorable phrasings.
2. Cross-reference compulsively: every new page MUST contain at least one wikilink (e.g., \`[ref](people/jane-doe)\` or \`[[people/jane-doe]]\`) to existing brain content. Use the search tool to find existing pages first.
3. Do NOT write to any path outside the allow-list shown in the put_page schema.
4. Slug discipline: lowercase alphanumeric and hyphens only, slash-separated segments. NO underscores, NO file extensions.

TASKS
A. Reflections (self-knowledge, pattern recognition, emotional processing):
   slug: \`wiki/personal/reflections/${dateHint}-<topic-slug>-${hashSuffix}\`

B. Originals (new ideas, frames, theses, mental models):
   slug: \`wiki/originals/ideas/${dateHint}-<idea-slug>-${hashSuffix}\`

C. People mentions: search first; if a page exists, do not put_page over it (the orchestrator handles people enrichment via timeline entries — your job is the reflection/original synthesis, NOT modifying existing person pages).

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
): Promise<string[]> {
  if (childIds.length === 0) return [];
  // Raw fetch — NO SELECT DISTINCT. Preserves per-child slug duplicates so
  // the orchestrator sees what each child wrote. COALESCE handles both
  // properly-stored jsonb objects (input->>'slug') and double-encoded jsonb
  // strings from pre-fix data ((input #>> '{}')::jsonb->>'slug').
  const rows = await engine.executeRaw<{ job_id: number; slug: string }>(
    `SELECT job_id,
            COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[])
        AND tool_name = 'brain_put_page'
        AND status = 'complete'`,
    [childIds],
  );
  const rewritten = new Set<string>();
  for (const r of rows) {
    if (typeof r.slug !== 'string' || r.slug.length === 0) continue;
    const ci = chunkInfo.get(r.job_id);
    rewritten.add(ci ? rewriteChunkedSlug(r.slug, ci.hash6, ci.idx) : r.slug);
  }
  return Array.from(rewritten).sort();
}

/**
 * D8: query for any `completed` legacy single-chunk job at the canonical
 * idempotency key shape `dream:synth:<filePath>:<hash16>`. Used at fan-out
 * time to detect transcripts that were synthesized under the pre-chunking
 * code path; those should NOT be re-submitted under chunked keys.
 *
 * Reuses the existing `minion_jobs.idempotency_key` index — no schema
 * additions. One indexed lookup per worth-processing transcript.
 */
async function hasLegacySingleChunkCompletion(
  engine: BrainEngine,
  filePath: string,
  hash16: string,
): Promise<boolean> {
  const legacyKey = `dream:synth:${filePath}:${hash16}`;
  const rows = await engine.executeRaw<{ status: string }>(
    `SELECT status
       FROM minion_jobs
      WHERE idempotency_key = $1
        AND status = 'completed'
      LIMIT 1`,
    [legacyKey],
  );
  return rows.length > 0;
}

// ── Reverse-write DB rows → markdown files ───────────────────────────

async function reverseWriteSlugs(
  engine: BrainEngine,
  brainDir: string,
  slugs: string[],
): Promise<number> {
  let count = 0;
  for (const slug of slugs) {
    const page = await engine.getPage(slug);
    if (!page) continue;
    const tags = await engine.getTags(slug);
    try {
      const md = renderPageToMarkdown(page, tags);
      const filePath = join(brainDir, `${slug}.md`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, md, 'utf8');
      count++;
    } catch (e) {
      // Per-slug failures are non-fatal — phase continues.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] reverse-write ${slug} failed: ${msg}\n`);
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
  const frontmatter: Record<string, unknown> = {
    ...((page.frontmatter ?? {}) as Record<string, unknown>),
    dream_generated: true,
    dream_cycle_date: today(),
  };
  return serializeMarkdown(
    frontmatter,
    page.compiled_truth ?? '',
    page.timeline ?? '',
    {
      type: (page.type as PageType) ?? 'note',
      title: page.title ?? '',
      tags,
    },
  );
}

// ── Summary index page ───────────────────────────────────────────────

async function writeSummaryPage(
  engine: BrainEngine,
  brainDir: string,
  summarySlug: string,
  summaryDate: string,
  writtenSlugs: string[],
  childOutcomes: Array<{ jobId: number; status: string }>,
): Promise<void> {
  const completed = childOutcomes.filter(c => c.status === 'completed').length;
  const failed = childOutcomes.length - completed;

  const lines: string[] = [];
  lines.push(`# Dream cycle ${summaryDate}`);
  lines.push('');
  lines.push(`**Children:** ${completed} completed, ${failed} failed/timeout.`);
  lines.push(`**Pages written:** ${writtenSlugs.length}.`);
  lines.push('');
  if (writtenSlugs.length > 0) {
    lines.push('## Pages');
    lines.push('');
    for (const s of writtenSlugs) {
      lines.push(`- [[${s}]]`);
    }
    lines.push('');
  }

  const body = lines.join('\n');
  // Stamp the dream-output identity marker into the summary's frontmatter.
  // parseMarkdown below round-trips it into the DB-stored frontmatter, so the
  // marker survives any later reverse-render of the summary page.
  const fullMarkdown = serializeMarkdown(
    { dream_generated: true, dream_cycle_date: summaryDate } as Record<string, unknown>,
    body,
    '',
    { type: 'note' as PageType, title: `Dream cycle ${summaryDate}`, tags: ['dream-cycle'] },
  );

  // Direct engine.putPage — orchestrator write, no subagent context, no
  // allow-list check (server-side viaSubagent=false). The summary slug is
  // pre-validated against SUMMARY_SLUG_RE in the caller.
  // Importing put_page via operations.ts would re-run namespace logic
  // unnecessarily; we go straight to the engine.
  const { parseMarkdown } = await import('../markdown.ts');
  const parsed = parseMarkdown(fullMarkdown);
  await engine.putPage(summarySlug, {
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
  });

  // Also write to disk (orchestrator dual-write).
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

function failed(error: PhaseError): PhaseResult {
  return {
    phase: 'synthesize',
    status: 'fail',
    duration_ms: 0,
    summary: 'synthesize phase failed',
    details: {},
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
};
