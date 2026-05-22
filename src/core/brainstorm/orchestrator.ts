/**
 * v0.37.0 — brainstorm + LSD orchestrator.
 *
 * Shared 4-phase pipeline driven by a `BrainstormProfile` config object
 * (D1 fold — output formatter + cost preview + types live in this file).
 *
 *   Phase 1: retrieve close-set via hybridSearch (K=4 brainstorm, K=2 LSD).
 *   Phase 2: fetch far-set via domain-bank (M=6 brainstorm, M=12 LSD).
 *   Phase 3: cross-generate ideas via gateway.chat (one call per close x far).
 *   Phase 4: judge via runJudge (D6 single-file, two configs).
 *
 * Trust boundary:
 *   - Far-page content goes through INJECTION_PATTERNS in domain-bank.ts.
 *   - Calibration anti-bias context (D4 + codex #8) consulted with cold-start
 *     fallback when active_bias_tags is empty.
 *   - Judge mid-run failure (D12) saves ideas with judge_failed:true.
 *
 * Cost guard (D8 + codex r2 #10):
 *   - Pre-run estimate to stderr + 10s TTY grace window (skipped non-TTY).
 *   - End-of-run actuals: "actual cost: $X (estimated $Y)" — operators can
 *     grep for `actual cost:` to track real spend.
 */

import type { BrainEngine } from '../engine.ts';
import { chat as defaultChat, embedQuery, type ChatResult, type ChatOpts } from '../ai/gateway.ts';
import { hybridSearch, hybridSearchCached } from '../search/hybrid.ts';
import { fetchFar, type CloseRef, type FarPage } from './domain-bank.ts';
import {
  runJudge,
  BRAINSTORM_JUDGE_CONFIG,
  LSD_JUDGE_CONFIG,
  type JudgeIdea,
  type JudgeIdeaResult,
  type JudgeConfig,
  type ChatFn,
} from './judges.ts';
import { ANTHROPIC_PRICING } from '../anthropic-pricing.ts';

// ---------------------------------------------------------------------------
// Profile (BrainstormProfile is the brainstorm vs LSD config object)
// ---------------------------------------------------------------------------

export interface BrainstormProfile {
  /** Stable label — used in stderr lines, frontmatter, audit. */
  label: 'brainstorm' | 'lsd';
  /** Close-set size from hybridSearch. brainstorm=4, lsd=2. */
  k_close: number;
  /** Far-set size from domain-bank. brainstorm=6, lsd=12. */
  m_far: number;
  /** Ideas to generate per (close × far) cross. */
  ideas_per_cross: number;
  /** Generation temperature. brainstorm=0.7 (steady), lsd=0.95 (loose). */
  temperature: number;
  /** Domain-bank stale-bias toggle. LSD only. */
  stale_bias: boolean;
  /** Judge config (rubric + threshold + LSD inversion rule). */
  judge_config: JudgeConfig;
  /** Whether to save by default. brainstorm=true (defensible output), lsd=false (ephemeral). */
  default_save: boolean;
  /** Frontmatter `mode:` value the dream-cycle hook reads (D4). */
  frontmatter_mode: 'brainstorm' | 'lsd';
  /** Generator system-prompt suffix — what's the vibe? */
  generator_voice: string;
  /** Optional generator-side constraint (LSD: axiomatic inversions required). */
  generator_constraint?: string;
}

export const BRAINSTORM_PROFILE: BrainstormProfile = Object.freeze({
  label: 'brainstorm',
  k_close: 4,
  m_far: 6,
  ideas_per_cross: 3,
  temperature: 0.7,
  stale_bias: false,
  judge_config: BRAINSTORM_JUDGE_CONFIG,
  default_save: true,
  frontmatter_mode: 'brainstorm',
  generator_voice: 'Defensible, cite-heavy. An analyst riffing with their own notes.',
});

export const LSD_PROFILE: BrainstormProfile = Object.freeze({
  label: 'lsd',
  k_close: 2,
  m_far: 12,
  ideas_per_cross: 4,
  temperature: 0.95,
  stale_bias: true,
  judge_config: LSD_JUDGE_CONFIG,
  default_save: false,
  frontmatter_mode: 'lsd',
  generator_voice: 'Your brain at 3am noticing a connection between things it has no business connecting.',
  generator_constraint: 'Every idea MUST invert at least one implicit axiom (X is good → X is the problem; everyone does Y → opposite; dominant narrative → hidden cause).',
});

// ---------------------------------------------------------------------------
// Caller-facing options + result shape
// ---------------------------------------------------------------------------

export interface BrainstormOptions {
  question: string;
  /** Profile selects brainstorm vs LSD; defaults to BRAINSTORM_PROFILE. */
  profile?: BrainstormProfile;
  /** Override the default chat model (subject to provider auth). */
  modelOverride?: string;
  /** Skip the cost-preview TTY grace window. Required for non-interactive callers. */
  skipCostPreview?: boolean;
  /** When set, force the user holder for calibration profile lookup. Falls back to config (`emotional_weight.user_holder`) then `'garry'`. */
  holderOverride?: string;
  /** Source scope. */
  sourceId?: string;
  sourceIds?: string[];
  /** AbortSignal for Ctrl-C / shutdown. */
  abortSignal?: AbortSignal;
  /** Override the gateway chat fn (tests only). */
  chatFn?: ChatFn;
  /** Override the gateway embedQuery fn (tests only). */
  embedQueryFn?: (text: string) => Promise<Float32Array>;
  /** Stderr sink — defaults to process.stderr.write. Tests pipe into a buffer. */
  stderrWrite?: (s: string) => void;
}

/** One idea emitted to the user, with citation transparency (D6). */
export interface BrainstormIdea {
  /** "01" .. "NN", stable within this run. */
  id: string;
  /** Free-form idea body (2-4 sentences). */
  text: string;
  /** Citation: close-set page slug. */
  close_slug: string;
  /** Citation: far-set page slug. */
  far_slug: string;
  /** D6 transparency badge — how far this collision actually traveled. */
  distance_score: number;
  /** Scoring from the judge. Absent when `judge_failed === true`. */
  judge?: JudgeIdeaResult;
  /** True iff this idea passed the judge threshold. */
  passes: boolean;
  /** True iff the judge call failed mid-run (D12). When true `judge` is absent and `passes=false`. */
  judge_failed?: boolean;
}

export interface BrainstormResult {
  profile_label: 'brainstorm' | 'lsd';
  question: string;
  /** Question embedding model used for distance calc. */
  embedding_model: string | null;
  /** All generated ideas (passed + filtered). Callers can render only `.filter(i => i.passes)`. */
  ideas: BrainstormIdea[];
  /** Close-set citations for the run header. */
  close_set: Array<{ slug: string; title: string | null }>;
  /** Far-set citations for the run header. */
  far_set: Array<{ slug: string; title: string | null; distance_score: number; source: 'prefix-stratified' | 'corpus-sample' }>;
  /** Calibration context applied during judging; `null` on cold-start. */
  active_bias_tags: string[] | null;
  /** D11 sparse signal — true when domain-bank couldn't fill m_far. */
  short_of_target: boolean;
  /** True iff judge phase failed and ideas were saved unscored (D12). */
  judge_failed: boolean;
  /** Cost actuals (codex r2 #10). */
  cost: {
    estimated_usd: number;
    actual_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Cost preview (D8 + codex r2 #10) — TTY grace + actuals
// ---------------------------------------------------------------------------

/**
 * Per-profile cost estimate. brainstorm: ~$0.05-0.15. lsd: ~$0.20-0.40.
 * Real numbers depend on configured model; we anchor on Sonnet pricing.
 * The estimate is informational — operators see actuals printed at run-end.
 */
export function estimateCost(profile: BrainstormProfile, model: string): number {
  const crosses = profile.k_close * profile.m_far;
  const ideas = crosses * profile.ideas_per_cross;
  // Rough per-cross budget: ~3K in, ~1.5K out (prompt + ideas).
  const inTokens = crosses * 3000;
  const outTokens = ideas * 250;
  // Judge: one batch ~ all ideas in, ~200 tokens per scored idea out.
  const judgeIn = ideas * 350;
  const judgeOut = ideas * 200;

  const pricing = ANTHROPIC_PRICING[model] ?? { input: 3, output: 15 };
  const inCost = ((inTokens + judgeIn) / 1_000_000) * pricing.input;
  const outCost = ((outTokens + judgeOut) / 1_000_000) * pricing.output;
  return inCost + outCost;
}

/** Pretty-print a USD cost with 2 decimals + leading dollar. */
function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Print the cost estimate + 10s TTY grace window. Non-TTY (cron, scripted)
 * auto-proceeds. `--yes` short-circuits via `skipCostPreview: true`.
 *
 * Returns true iff the user pressed Ctrl-C during the grace window.
 */
export async function previewCostAndWait(opts: {
  profile: BrainstormProfile;
  model: string;
  skip: boolean;
  stderrWrite: (s: string) => void;
  /** Test seam — override the wait so suites don't hang. */
  graceMs?: number;
}): Promise<{ aborted: boolean; estimate: number }> {
  const estimate = estimateCost(opts.profile, opts.model);
  const isTTY = typeof process !== 'undefined' && process.stderr?.isTTY === true;
  opts.stderrWrite(
    `[${opts.profile.label}] estimated cost: ${fmtUsd(estimate)} (${opts.profile.k_close}×${opts.profile.m_far} = ${opts.profile.k_close * opts.profile.m_far} crosses × ${opts.profile.ideas_per_cross} ideas + judge)\n`
  );
  if (opts.skip || !isTTY) {
    return { aborted: false, estimate };
  }
  opts.stderrWrite(`[${opts.profile.label}] Press Ctrl-C within 10s to abort, or wait to proceed...\n`);
  const ms = opts.graceMs ?? 10_000;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      cleanup();
      resolve({ aborted: false, estimate });
    }, ms);
    const onSigint = () => {
      cleanup();
      opts.stderrWrite(`[${opts.profile.label}] Aborted by user.\n`);
      resolve({ aborted: true, estimate });
    };
    function cleanup() {
      clearTimeout(t);
      process.off?.('SIGINT', onSigint);
    }
    process.on?.('SIGINT', onSigint);
  });
}

// ---------------------------------------------------------------------------
// Calibration profile load (D4 + codex #8 cold-start fallback)
// ---------------------------------------------------------------------------

/**
 * Load the latest published calibration profile for the user holder.
 * Cold-start gate: returns null when no row exists OR active_bias_tags is empty.
 * The orchestrator stderr-warns when null so users know the judge ran unbiased.
 */
export async function loadCalibrationContext(
  engine: BrainEngine,
  opts: { holder: string; sourceId?: string }
): Promise<{ active_bias_tags: string[]; pattern_statements: string[] } | null> {
  const sourceClause = opts.sourceId
    ? `AND source_id = '${opts.sourceId.replace(/'/g, "''")}'`
    : '';
  let rows: Array<{ active_bias_tags: string[]; pattern_statements: string[] }>;
  try {
    rows = await engine.executeRaw(
      `SELECT active_bias_tags, pattern_statements
         FROM calibration_profiles
         WHERE holder = $1 ${sourceClause}
         ORDER BY generated_at DESC
         LIMIT 1`,
      [opts.holder]
    ) as Array<{ active_bias_tags: string[]; pattern_statements: string[] }>;
  } catch {
    // Pre-v0.36.1 brains: calibration_profiles table doesn't exist.
    return null;
  }
  if (rows.length === 0) return null;
  const row = rows[0];
  const tags = Array.isArray(row.active_bias_tags) ? row.active_bias_tags : [];
  const patterns = Array.isArray(row.pattern_statements) ? row.pattern_statements : [];
  if (tags.length === 0) return null; // codex #8 cold-start gate
  return { active_bias_tags: tags, pattern_statements: patterns };
}

// ---------------------------------------------------------------------------
// Idea generation prompts + response parsing
// ---------------------------------------------------------------------------

/** Build a single (close × far) cross-generation prompt. */
function buildCrossPrompt(opts: {
  profile: BrainstormProfile;
  question: string;
  close: { slug: string; title: string | null; content: string };
  far: FarPage;
}): { system: string; user: string } {
  const system = `You are an idea generator using bisociation (Arthur Koestler, 1964). You surface non-trivial ideas by colliding two pages from a user's own knowledge brain.

Voice: ${opts.profile.generator_voice}

Style rules:
- Short, assertive sentences. Zero hedging.
- Each idea starts from a principle, not anecdote.
- Cite BOTH the close and far slug verbatim — these are the user's own notes.
- Never fabricate facts, figures, or quotes. Stay grounded in the cited pages.${opts.profile.generator_constraint ? `\n- ${opts.profile.generator_constraint}` : ''}`;

  const user = `QUESTION:
${opts.question}

CLOSE PAGE (related to the question — context anchor):
[${opts.close.slug}] ${opts.close.title ?? '(untitled)'}
${opts.close.content.slice(0, 1500)}

FAR PAGE (from a distant region of the user's brain — the collision partner):
[${opts.far.slug}] ${opts.far.title ?? '(untitled)'}
${opts.far.content}

Generate exactly ${opts.profile.ideas_per_cross} ideas from cross-pollinating these pages.

Output format (one idea per ## block, no JSON):
## Idea 1
[2-4 sentences. Reference [${opts.close.slug}] and [${opts.far.slug}].]

## Idea 2
[2-4 sentences. Reference [${opts.close.slug}] and [${opts.far.slug}].]

(Continue for all ${opts.profile.ideas_per_cross} ideas.)`;

  return { system, user };
}

/**
 * Parse the generator's idea output. Tolerant: matches `## Idea N`, `### Idea N`,
 * or `## N.` headings. Falls back to splitting on double newlines if no headers
 * match (very loose, last resort).
 */
export function parseIdeaResponse(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  // Primary: split on `## Idea N` or `### Idea N` (case-insensitive).
  const headerRe = /^#{2,4}\s*(?:idea\s+)?\d+[.:\s\-]*/gim;
  const parts = text.split(headerRe).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length >= 2) return parts; // first chunk might be a preamble or first idea; keep all non-empty.
  // Fallback: split on numbered list `1. ... 2. ... 3. ...`.
  const numberedRe = /^\s*\d+\.\s+/gm;
  const numbered = text.split(numberedRe).map((p) => p.trim()).filter((p) => p.length > 0);
  if (numbered.length >= 2) return numbered;
  // Last resort: split on blank lines.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 30);
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Bounded parallelism via a simple counting semaphore
// ---------------------------------------------------------------------------

async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  worker: (item: I, idx: number) => Promise<O>
): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) break;
        results[i] = await worker(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Public orchestrator entry point
// ---------------------------------------------------------------------------

const DEFAULT_PARALLELISM = 4;

/**
 * Run the brainstorm or LSD pipeline. The CLI command (`gbrain brainstorm` /
 * `gbrain lsd`) calls this with the question + profile; renders the result
 * via formatBrainstormMarkdown; optionally saves via put_page.
 */
export async function runBrainstorm(
  engine: BrainEngine,
  config: { embedding_model?: string; emotional_weight?: { user_holder?: string } },
  opts: BrainstormOptions
): Promise<BrainstormResult> {
  const profile = opts.profile ?? BRAINSTORM_PROFILE;
  const stderr = opts.stderrWrite ?? ((s: string) => { process.stderr.write(s); });
  const chat = opts.chatFn ?? defaultChat;
  const embedFn = opts.embedQueryFn ?? embedQuery;

  // ---- Phase 0: cost preview + TTY grace ----
  const modelStr = opts.modelOverride ?? 'anthropic:claude-sonnet-4-6';
  const { aborted, estimate } = await previewCostAndWait({
    profile,
    model: modelStr,
    skip: opts.skipCostPreview === true,
    stderrWrite: stderr,
  });
  if (aborted) {
    throw new Error('brainstorm: aborted before run (Ctrl-C during cost preview window)');
  }

  // ---- Phase 1: question embedding + close-set retrieval ----
  let questionEmbedding: Float32Array | null = null;
  try {
    questionEmbedding = await embedFn(opts.question);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`[${profile.label}] WARN: question embedding failed (${msg}); distance scores will be neutral.\n`);
  }

  // hybridSearch for close-set. Limit to profile.k_close. Source-scoped.
  let closeResults = await hybridSearch(engine, opts.question, {
    limit: profile.k_close,
    sourceId: opts.sourceId,
    sourceIds: opts.sourceIds,
  });
  // Defensive: dedup by slug.
  const seen = new Set<string>();
  closeResults = closeResults.filter((r) => {
    if (seen.has(r.slug)) return false;
    seen.add(r.slug);
    return true;
  });
  if (closeResults.length === 0) {
    // K=0 LSD case is intentional; for brainstorm an empty close-set means
    // "no related pages" — proceed, all crosses use the question as the
    // sole anchor (no close-page context).
    stderr(`[${profile.label}] WARN: no close-set pages matched the question; proceeding with empty anchor.\n`);
  }
  const closeSet: CloseRef[] = closeResults.map((r) => ({
    slug: r.slug,
    prefix: extractPrefix(r.slug),
  }));

  // ---- Phase 2: domain-bank fetch ----
  const farResult = await fetchFar(engine, {
    m: profile.m_far,
    closeSet,
    questionEmbedding,
    staleBias: profile.stale_bias,
    sourceId: opts.sourceId,
    sourceIds: opts.sourceIds,
  });
  if (farResult.short_of_target) {
    // D11 data-driven warning text.
    stderr(
      `[${profile.label}] WARN: Only ${farResult.available_prefixes} distinct prefixes available, expected ${profile.m_far} — ideas will be drawn from a narrower domain bank than usual.\n`
    );
  }
  if (farResult.pages.length === 0) {
    throw new Error(
      `${profile.label}: brain has no usable far pages. Try \`gbrain import <dir>\` to seed cross-domain content, or check the prefix cache via \`gbrain doctor\`.`
    );
  }

  // ---- Phase 3: calibration context (cold-start fallback) ----
  const holder = opts.holderOverride ?? config.emotional_weight?.user_holder ?? 'garry';
  const calibContext = await loadCalibrationContext(engine, {
    holder,
    sourceId: opts.sourceId,
  });
  const activeBiasTags = calibContext?.active_bias_tags ?? null;
  if (!activeBiasTags) {
    stderr(`[${profile.label}] calibration cold-start, judging without bias context.\n`);
  }

  // Map close slugs → titles for the cross-prompt (we have slug from
  // hybridSearch; we don't have the page bodies for close-set, so we read
  // them now from the engine — small cost, ~K pages, no domain-bank lookup).
  const closeFull = await Promise.all(
    closeResults.map(async (r) => {
      const page = await engine.getPage(r.slug, opts.sourceId ? { sourceId: opts.sourceId } : undefined);
      return {
        slug: r.slug,
        title: page?.title ?? null,
        content: page?.compiled_truth ?? '',
      };
    })
  );

  // ---- Phase 3.5: generate ideas across (close × far) crosses ----
  // When closeSet is empty, fabricate a single "anchor-less" close entry so
  // the cross still happens (LSD K=0 path).
  const closesForCross = closeFull.length > 0
    ? closeFull
    : [{ slug: '(no anchor)', title: 'question only', content: opts.question }];
  type Cross = {
    close: { slug: string; title: string | null; content: string };
    far: FarPage;
  };
  const crosses: Cross[] = [];
  for (const c of closesForCross) {
    for (const f of farResult.pages) {
      crosses.push({ close: c, far: f });
    }
  }

  let totalUsage = { input_tokens: 0, output_tokens: 0 };
  let crossModel = modelStr;

  // Parallelize chat calls bounded at DEFAULT_PARALLELISM.
  const rawIdeasByCross = await mapWithConcurrency(crosses, DEFAULT_PARALLELISM, async (cross) => {
    const { system, user } = buildCrossPrompt({
      profile,
      question: opts.question,
      close: cross.close,
      far: cross.far,
    });
    const chatOpts: ChatOpts = {
      model: opts.modelOverride,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1500,
      abortSignal: opts.abortSignal,
    };
    try {
      const result = await chat(chatOpts);
      totalUsage.input_tokens += result.usage.input_tokens;
      totalUsage.output_tokens += result.usage.output_tokens;
      crossModel = result.model;
      const parsed = parseIdeaResponse(result.text);
      return parsed.slice(0, profile.ideas_per_cross).map((text) => ({
        text,
        close_slug: cross.close.slug,
        far_slug: cross.far.slug,
        distance_score: cross.far.distance_score,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`[${profile.label}] WARN: cross [${cross.close.slug}] × [${cross.far.slug}] failed: ${msg}\n`);
      return [];
    }
  });

  // Flatten + assign stable ids.
  const allRawIdeas: Array<{ id: string; text: string; close_slug: string; far_slug: string; distance_score: number }> = [];
  for (const ideas of rawIdeasByCross) {
    for (const idea of ideas) {
      const id = String(allRawIdeas.length + 1).padStart(2, '0');
      allRawIdeas.push({ id, ...idea });
    }
  }

  if (allRawIdeas.length === 0) {
    throw new Error(
      `${profile.label}: no ideas generated across ${crosses.length} crosses. Check API keys via \`gbrain models doctor\`.`
    );
  }

  // ---- Phase 4: judge ----
  let judgeFailed = false;
  let judgedById: Map<string, JudgeIdeaResult> = new Map();
  let judgeUsage = { input_tokens: 0, output_tokens: 0 };
  try {
    const judgeInput: JudgeIdea[] = allRawIdeas.map((i) => ({
      id: i.id,
      text: i.text,
      close_slug: i.close_slug,
      far_slug: i.far_slug,
    }));
    const judgeResult = await runJudge(profile.judge_config, judgeInput, {
      modelOverride: opts.modelOverride,
      chatFn: opts.chatFn,
      activeBiasTags: activeBiasTags ?? undefined,
      abortSignal: opts.abortSignal,
    });
    for (const idea of judgeResult.ideas) {
      judgedById.set(idea.id, idea);
    }
    judgeUsage = {
      input_tokens: judgeResult.usage.input_tokens,
      output_tokens: judgeResult.usage.output_tokens,
    };
  } catch (err) {
    judgeFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`[${profile.label}] WARN: judge phase failed (${msg}); saving ideas unscored. Re-run with --retry-judge to score.\n`);
  }

  // ---- Phase 5: assemble BrainstormResult ----
  const ideas: BrainstormIdea[] = allRawIdeas.map((raw) => {
    const j = judgedById.get(raw.id);
    return {
      id: raw.id,
      text: raw.text,
      close_slug: raw.close_slug,
      far_slug: raw.far_slug,
      distance_score: raw.distance_score,
      judge: j,
      passes: j?.passes ?? false,
      judge_failed: judgeFailed,
    };
  });

  // Cost actuals (codex r2 #10).
  const totalIn = totalUsage.input_tokens + judgeUsage.input_tokens;
  const totalOut = totalUsage.output_tokens + judgeUsage.output_tokens;
  const pricing = ANTHROPIC_PRICING[crossModel] ?? { input: 3, output: 15 };
  const actual = (totalIn / 1_000_000) * pricing.input + (totalOut / 1_000_000) * pricing.output;
  stderr(`[${profile.label}] actual cost: ${fmtUsd(actual)} (estimated ${fmtUsd(estimate)}) — in=${totalIn} out=${totalOut} tokens\n`);

  return {
    profile_label: profile.label,
    question: opts.question,
    embedding_model: config.embedding_model ?? null,
    ideas,
    close_set: closeFull.map((c) => ({ slug: c.slug, title: c.title })),
    far_set: farResult.pages.map((f) => ({
      slug: f.slug,
      title: f.title,
      distance_score: f.distance_score,
      source: f.source,
    })),
    active_bias_tags: activeBiasTags,
    short_of_target: farResult.short_of_target,
    judge_failed: judgeFailed,
    cost: {
      estimated_usd: estimate,
      actual_usd: actual,
      input_tokens: totalIn,
      output_tokens: totalOut,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the 2-segment top-level prefix from a slug. Returns null for slugs
 * that don't match the `^[^/]+/[^/]+` pattern (single-segment, empty).
 * Mirrors the SQL `substring(slug from '^[^/]+/[^/]+')` so the orchestrator
 * and the engine agree on what counts as a "prefix."
 */
export function extractPrefix(slug: string): string | null {
  const m = slug.match(/^([^/]+\/[^/]+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Output formatter (D6 citation badges, D1 fold)
// ---------------------------------------------------------------------------

/**
 * Render BrainstormResult as user-facing markdown. Citation badges per D6:
 * each idea cites close + far slugs AND its normalized distance score.
 *
 * @param onlyPassed When true (default), filter to `passes === true` ideas.
 *   Pass false to see the full set including filtered-out + judge-failed rows.
 */
export function formatBrainstormMarkdown(
  result: BrainstormResult,
  opts: { onlyPassed?: boolean; includeMeta?: boolean } = {}
): string {
  const onlyPassed = opts.onlyPassed ?? true;
  const includeMeta = opts.includeMeta ?? true;
  const ideasToShow = onlyPassed
    ? result.ideas.filter((i) => i.passes)
    : result.ideas;

  const lines: string[] = [];

  if (includeMeta) {
    lines.push(`# ${result.profile_label === 'lsd' ? 'LSD' : 'Brainstorm'}: ${result.question}`);
    lines.push('');
    if (result.judge_failed) {
      lines.push('> **Judge phase failed mid-run** — ideas below are unscored. Re-run with `--retry-judge` to score.');
      lines.push('');
    }
    if (result.short_of_target) {
      lines.push(`> _Note: domain bank was narrower than usual — see stderr warning._`);
      lines.push('');
    }
    if (result.active_bias_tags === null) {
      lines.push(`> _Note: calibration cold-start — ideas were judged without anti-bias context._`);
      lines.push('');
    }
    lines.push(`**Close set** (${result.close_set.length}):`);
    for (const c of result.close_set) {
      lines.push(`- \`${c.slug}\`${c.title ? ` — ${c.title}` : ''}`);
    }
    lines.push('');
    lines.push(`**Far set** (${result.far_set.length}, ${result.far_set.filter((f) => f.source === 'corpus-sample').length} via corpus-sample fallback):`);
    for (const f of result.far_set) {
      lines.push(`- \`${f.slug}\` — distance ${f.distance_score.toFixed(2)}${f.title ? ` — ${f.title}` : ''}`);
    }
    lines.push('');
  }

  lines.push(`## Ideas (${ideasToShow.length}${onlyPassed && result.ideas.length !== ideasToShow.length ? ` of ${result.ideas.length}` : ''})`);
  lines.push('');
  for (const idea of ideasToShow) {
    const scoreSuffix = idea.judge
      ? ` _(score ${idea.judge.weighted_score.toFixed(2)})_`
      : (idea.judge_failed ? ` _(unscored — judge failed)_` : '');
    lines.push(`### Idea ${idea.id}${scoreSuffix}`);
    lines.push('');
    lines.push(idea.text);
    lines.push('');
    lines.push(`_Citation: \`${idea.close_slug}\` × \`${idea.far_slug}\` — distance ${idea.distance_score.toFixed(2)}_`);
    if (idea.judge?.note) {
      lines.push(`_Judge note: ${idea.judge.note}_`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Frontmatter for a saved brainstorm/lsd page. */
export function buildBrainstormFrontmatter(result: BrainstormResult, opts: { slug: string }): string {
  const date = new Date().toISOString().slice(0, 10);
  const judgeFailed = result.judge_failed ? '\njudge_failed: true' : '';
  const unscored = result.judge_failed ? '\nunscored: true' : '';
  return `---
title: "${result.profile_label === 'lsd' ? 'LSD' : 'Brainstorm'}: ${result.question.replace(/"/g, '\\"').slice(0, 100)}"
mode: ${result.profile_label}
generated_at: ${new Date().toISOString()}
date: ${date}
question: "${result.question.replace(/"/g, '\\"').slice(0, 200)}"
close_slugs: [${result.close_set.map((c) => `"${c.slug}"`).join(', ')}]
far_slugs: [${result.far_set.map((f) => `"${f.slug}"`).join(', ')}]
short_of_target: ${result.short_of_target}
calibration_cold_start: ${result.active_bias_tags === null}${judgeFailed}${unscored}
cost_usd: ${result.cost.actual_usd.toFixed(4)}
---

`;
}
