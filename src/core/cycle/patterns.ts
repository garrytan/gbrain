/**
 * Patterns phase (v0.23) — cross-session theme detection.
 *
 * Reads recent reflections (within `lookback_days`), runs a single Sonnet
 * subagent to surface themes that recur across ≥`min_evidence` distinct
 * reflections, and writes one pattern page per theme.
 *
 * MUST run after `extract` so the graph state (links, timeline) is fresh.
 * Subagent put_page calls have ctx.remote=true; the trusted-workspace
 * allow-list re-enables auto-link / auto-timeline for synth + pattern
 * writes (operations.ts:trustedWorkspace branch).
 *
 * v1 behavior:
 *   - Single Sonnet subagent (no fan-out — one job per cycle is plenty).
 *   - Idempotent: if reflection set is below `min_evidence`, phase is skipped.
 *   - Pattern slug uses LLM's chosen topic-slug (subagent prompt instructs format).
 *   - Existing pattern pages are updated in place via put_page (idempotent
 *     ON CONFLICT semantics in importFromContent).
 */

import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult, PhaseError } from '../cycle.ts';
import { MinionQueue } from '../minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionJobInput, SubagentHandlerData } from '../minions/types.ts';
import { serializeMarkdown } from '../markdown.ts';
import type { Page, PageType } from '../types.ts';
// #2415: allow-list + output-root resolution shared with the synthesize
// phase — both phases must agree on the configured namespace.
import { loadAllowedSlugPrefixes, loadOutputRoot } from './synthesize.ts';
import { probeChatModel } from '../ai/gateway.ts';
import { normalizeModelId } from '../model-id.ts';

export interface PatternsPhaseOpts {
  brainDir: string;
  dryRun: boolean;
  yieldDuringPhase?: () => Promise<void>;
  /**
   * Absolute deadline (epoch ms) of the enclosing minion job, or null for
   * direct callers (`gbrain dream`). When set, the subagent's job timeout
   * and the wait timeout are clamped so the phase finishes (or times out)
   * BEFORE the parent job's budget expires — a fixed 30/35-min default
   * inside an interval-derived cycle budget dead-letters the whole cycle
   * mid-phase and starves every tail phase (#2781).
   */
  deadlineAtMs?: number | null;
}

/**
 * Stop-margin reserved under the parent deadline when clamping subagent
 * budgets. NOT a promise that tail phases complete — the cycle is allowed
 * to go partial and resume next tick. This only guarantees the phase's
 * wait returns and the handler unwinds cleanly before the worker's abort
 * fires: wait poll interval (5s) + worker force-evict grace (30s) + lock
 * and DB cleanup headroom.
 */
export const CYCLE_DEADLINE_RESERVE_MS = 60 * 1000;

/**
 * Smallest remaining budget worth submitting a subagent for. Below this,
 * the LLM call is near-certain to be killed mid-flight — wasted spend and
 * a guaranteed-timeout child — so the phase skips honestly instead
 * (`insufficient_cycle_budget`) and the next cycle retries with a fresh
 * budget.
 */
export const MIN_PATTERNS_SUBAGENT_BUDGET_MS = 2 * 60 * 1000;

/**
 * Clamp the configured subagent budgets to the remaining parent-job time.
 * Both timeouts derive from the SAME absolute child deadline
 * (`deadlineAtMs - reserve`) so the child job's kill switch and our wait
 * agree. Returns null when the remaining budget is below the minimum —
 * caller should skip the phase without submitting.
 */
export function clampSubagentBudgets(
  config: { subagentTimeoutMs: number; subagentWaitTimeoutMs: number },
  deadlineAtMs: number | null | undefined,
  nowMs: number,
): { timeoutMs: number; waitTimeoutMs: number } | null {
  if (deadlineAtMs == null) {
    return { timeoutMs: config.subagentTimeoutMs, waitTimeoutMs: config.subagentWaitTimeoutMs };
  }
  const childBudgetMs = deadlineAtMs - CYCLE_DEADLINE_RESERVE_MS - nowMs;
  if (childBudgetMs < MIN_PATTERNS_SUBAGENT_BUDGET_MS) return null;
  return {
    timeoutMs: Math.min(config.subagentTimeoutMs, childBudgetMs),
    waitTimeoutMs: Math.min(config.subagentWaitTimeoutMs, childBudgetMs),
  };
}

export async function runPhasePatterns(
  engine: BrainEngine,
  opts: PatternsPhaseOpts,
): Promise<PhaseResult> {
  const start = Date.now();
  try {
    const config = await loadPatternsConfig(engine);

    if (!config.enabled) {
      return skipped('disabled', 'dream.patterns.enabled is false');
    }

    // Gather reflections within lookback window.
    const reflections = await gatherReflections(engine, config.lookbackDays, config.outputRoot);
    if (reflections.length < config.minEvidence) {
      return skipped(
        'insufficient_evidence',
        `${reflections.length} reflections in last ${config.lookbackDays}d (need ≥${config.minEvidence})`,
      );
    }

    if (opts.dryRun) {
      return ok(`dry-run: would detect patterns over ${reflections.length} reflections`, {
        reflections_considered: reflections.length,
        patterns_written: 0,
        dryRun: true,
      });
    }

    // Submit one subagent for pattern detection. The subagent dispatches via
    // the gateway model-tier resolver, so gate on "is the resolved model's
    // provider reachable" rather than ANTHROPIC_API_KEY specifically — a
    // hardcoded env gate misclassified non-Anthropic stacks (litellm,
    // deepseek, openrouter, ...) as "no upstream" even though the subagent
    // routes them through the gateway (agent.use_gateway_loop), and it missed
    // Anthropic keys set via `gbrain config set anthropic_api_key`. Same
    // probe semantics as think/index.ts + synthesize's makeJudgeClient:
    // unknown provider/model or Anthropic-without-key skips cheaply; other
    // providers' auth is checked lazily at dispatch and surfaces in the job
    // outcome. (Takeover of PR #2279's intent by @brettdavies.)
    const probe = probeChatModel(normalizeModelId(config.model));
    if (!probe.ok) {
      return skipped('no_provider', `pattern detection skipped: ${probe.detail}`);
    }

    const allowedSlugPrefixes = await loadAllowedSlugPrefixes(config.outputRoot);
    if (allowedSlugPrefixes.length === 0) {
      return failed(makeError('InternalError', 'NO_ALLOWLIST',
        'skills/_brain-filing-rules.json missing dream_synthesize_paths.globs'));
    }

    // #2781: budget the subagent from the REMAINING parent-job time, not
    // the fixed config default. Checked after the cheap gates (disabled /
    // insufficient_evidence / no_provider) so a skip for budget reasons
    // only fires when the phase would otherwise have submitted.
    const budgets = clampSubagentBudgets(config, opts.deadlineAtMs, Date.now());
    if (budgets === null) {
      return skipped(
        'insufficient_cycle_budget',
        `remaining cycle budget under ${Math.round(MIN_PATTERNS_SUBAGENT_BUDGET_MS / 1000)}s ` +
        `(reserve ${Math.round(CYCLE_DEADLINE_RESERVE_MS / 1000)}s); next cycle retries with a fresh budget`,
      );
    }

    const queue = new MinionQueue(engine);
    const data: SubagentHandlerData = {
      prompt: buildPatternsPrompt(reflections, config.minEvidence, config.outputRoot),
      model: config.model,
      max_turns: 30,
      allowed_slug_prefixes: allowedSlugPrefixes,
    };
    const submitOpts: Partial<MinionJobInput> = {
      max_stalled: 3,
      timeout_ms: budgets.timeoutMs,
    };
    const job = await queue.add('subagent', data as unknown as Record<string, unknown>, submitOpts, {
      allowProtectedSubmit: true,
    });

    let outcome: string;
    try {
      const final = await waitForCompletion(queue, job.id, {
        timeoutMs: budgets.waitTimeoutMs,
        pollMs: 5 * 1000,
      });
      outcome = final.status;
    } catch (e) {
      if (e instanceof TimeoutError) {
        outcome = 'timeout';
        // The child's own timeout_ms clock starts at ITS claim, not at
        // submit — a child that sat queued behind other work can outlive
        // the parent deadline this wait was clamped to. Cancel it so the
        // subagent can't keep spending/writing after the phase gave up
        // (waiting child → cancelled immediately; active child → lock
        // stripped, worker abort fires on next renew tick).
        try { await queue.cancelJob(job.id); } catch { /* best-effort */ }
      } else {
        throw e;
      }
    }

    if (opts.yieldDuringPhase) {
      try { await opts.yieldDuringPhase(); } catch { /* best-effort */ }
    }

    // Collect refs the subagent wrote (codex finding #2 — query tool exec rows).
    // v0.32.8: refs carry source_id so reverseWriteRefs targets the right
    // (source, slug) row instead of the first DB match.
    const writtenRefs = await collectChildPutPageSlugs(engine, [job.id]);

    // Reverse-write to fs.
    const reverseWriteCount = await reverseWriteRefs(engine, opts.brainDir, writtenRefs);

    const details = {
      reflections_considered: reflections.length,
      patterns_written: writtenRefs.length,
      reverse_write_count: reverseWriteCount,
      child_outcome: outcome,
      job_id: job.id,
    };

    // #2782: the phase status must reflect the child outcome. Pre-fix this
    // returned status:ok even when the subagent timed out (e.g. no
    // subagent-capable worker slot free for the whole wait window) and zero
    // pattern pages were written — a silent no-op for days.
    if (outcome !== 'complete') {
      if (writtenRefs.length === 0) {
        return {
          phase: 'patterns',
          status: 'fail',
          duration_ms: 0,
          summary: `pattern-detection subagent job ${job.id} ended '${outcome}'; nothing was written`,
          details,
          error: makeError(
            outcome === 'timeout' ? 'Timeout' : 'InternalError',
            `PATTERNS_CHILD_${outcome.toUpperCase()}`,
            `subagent job ${job.id} outcome '${outcome}' with zero pattern pages written`,
            outcome === 'timeout'
              ? 'A timeout with zero writes usually means no subagent-capable worker claimed the job. Check `gbrain jobs list` and worker capacity.'
              : undefined,
          ),
        };
      }
      // Partial: the child died/timed out but some pages landed first.
      return {
        phase: 'patterns',
        status: 'warn',
        duration_ms: 0,
        summary: `${writtenRefs.length} pattern page(s) written but subagent job ${job.id} ended '${outcome}'`,
        details,
      };
    }

    return ok(`${writtenRefs.length} pattern page(s) written/updated (${outcome})`, details);
  } catch (e) {
    return failed(makeError('InternalError', 'PATTERNS_PHASE_FAIL',
      e instanceof Error ? (e.message || 'patterns phase threw') : String(e)));
  } finally {
    void start;
  }
}

// ── Config ────────────────────────────────────────────────────────────

interface PatternsConfig {
  enabled: boolean;
  lookbackDays: number;
  minEvidence: number;
  model: string;
  /** #2415: shared output namespace (dream.synthesize.output_root, default 'wiki'). */
  outputRoot: string;
  /** #1594-family: subagent job timeout, config `dream.patterns.subagent_timeout_ms`. */
  subagentTimeoutMs: number;
  /** #1594-family: waitForCompletion timeout, config `dream.patterns.subagent_wait_timeout_ms`. */
  subagentWaitTimeoutMs: number;
}

const DEFAULT_PATTERNS_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PATTERNS_SUBAGENT_WAIT_TIMEOUT_MS = 35 * 60 * 1000;

async function getNumberConfig(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  return Number.isNaN(value) ? fallback : value;
}

async function loadPatternsConfig(engine: BrainEngine): Promise<PatternsConfig> {
  const enabledStr = await engine.getConfig('dream.patterns.enabled');
  const enabled = enabledStr === null ? true : enabledStr === 'true';
  const lookbackStr = await engine.getConfig('dream.patterns.lookback_days');
  const minEvidenceStr = await engine.getConfig('dream.patterns.min_evidence');
  // v0.28: unified model resolution
  const { resolveModel } = await import('../model-config.ts');
  const model = await resolveModel(engine, {
    configKey: 'models.dream.patterns',
    deprecatedConfigKey: 'dream.patterns.model',
    tier: 'reasoning',
    fallback: 'sonnet',
  });
  return {
    enabled,
    lookbackDays: lookbackStr ? Math.max(1, parseInt(lookbackStr, 10) || 30) : 30,
    minEvidence: minEvidenceStr ? Math.max(1, parseInt(minEvidenceStr, 10) || 3) : 3,
    model,
    outputRoot: await loadOutputRoot(engine),
    subagentTimeoutMs: await getNumberConfig(
      engine, 'dream.patterns.subagent_timeout_ms', DEFAULT_PATTERNS_SUBAGENT_TIMEOUT_MS,
    ),
    subagentWaitTimeoutMs: await getNumberConfig(
      engine, 'dream.patterns.subagent_wait_timeout_ms', DEFAULT_PATTERNS_SUBAGENT_WAIT_TIMEOUT_MS,
    ),
  };
}

// ── Reflection gathering ─────────────────────────────────────────────

interface ReflectionRef {
  slug: string;
  title: string;
  excerpt: string;
}

async function gatherReflections(
  engine: BrainEngine,
  lookbackDays: number,
  outputRoot = 'wiki',
): Promise<ReflectionRef[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  // #2415: reflections live under the configured output root (bound as a
  // parameter; outputRoot is slug-grammar-validated by loadOutputRoot).
  const rows = await engine.executeRaw<{ slug: string; title: string | null; compiled_truth: string | null }>(
    `SELECT slug, title, compiled_truth
       FROM pages
      WHERE slug LIKE $2
        AND updated_at >= $1::timestamptz
      ORDER BY updated_at DESC
      LIMIT 100`,
    [since, `${outputRoot}/personal/reflections/%`],
  );
  return rows.map(r => ({
    slug: r.slug,
    title: r.title ?? r.slug,
    excerpt: (r.compiled_truth ?? '').slice(0, 600),
  }));
}

// ── Prompt ────────────────────────────────────────────────────────────

function buildPatternsPrompt(reflections: ReflectionRef[], minEvidence: number, outputRoot = 'wiki'): string {
  const today = new Date().toISOString().slice(0, 10);
  const corpus = reflections
    .map((r, i) => `### ${i + 1}. [[${r.slug}]] — ${r.title}\n${r.excerpt}`)
    .join('\n\n---\n\n');

  return `You are surfacing recurring themes across the user's recent reflections.

OUTPUT POLICY
- Only name a pattern if it appears in at least ${minEvidence} DISTINCT reflections.
- Each pattern page MUST cite the reflections that constitute its evidence (use [[${outputRoot}/personal/reflections/...]] wikilinks).
- Use \`search\` to check whether a similar pattern page already exists; if yes, update it (use the same slug). If no, create a new one.
- Pattern slug format: \`${outputRoot}/personal/patterns/<topic-slug>\` (lowercase alphanumeric + hyphens; no underscores, no extension, no date).
- A "pattern" is a recurring theme, anxiety, decision pattern, relationship dynamic, or self-knowledge motif. NOT a single insight. NOT a list of unrelated topics.

DO NOT WRITE
- A "patterns from today" digest (that's the dream-cycle-summaries page; not your job).
- Patterns with <${minEvidence} reflections cited.
- Anything outside ${outputRoot}/personal/patterns/.

CONTEXT
- Today: ${today}
- Reflections in scope: ${reflections.length}

REFLECTIONS
${corpus}

When done, briefly list the pattern slugs you wrote/updated in your final message.`;
}

// ── Provenance via put_page tool execution rows ─────────────────────

async function collectChildPutPageSlugs(
  engine: BrainEngine,
  childIds: number[],
): Promise<Array<{ slug: string; source_id: string }>> {
  if (childIds.length === 0) return [];
  // v0.32.8: subagent put_page tool schema doesn't expose source_id (subagents
  // are scoped to a single source). Default to 'default' here; multi-source
  // dream cycles are a v0.33 follow-up. The point of threading source_id is
  // so reverseWriteRefs can pass it through getPage and pick the correct
  // (source_id, slug) row instead of whatever the DB happens to return.
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT
            COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[])
        AND tool_name = 'brain_put_page'
        AND status = 'complete'
      ORDER BY 1`,
    [childIds],
  );
  return rows
    .map(r => r.slug)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map(slug => ({ slug, source_id: 'default' }));
}

// ── Reverse-write ────────────────────────────────────────────────────

import { validateSourceId } from '../utils.ts';

async function reverseWriteRefs(
  engine: BrainEngine,
  brainDir: string,
  refs: Array<{ slug: string; source_id: string }>,
): Promise<number> {
  let count = 0;
  for (const { slug, source_id } of refs) {
    // v0.32.8 F6: guard against malformed source_id (would let join() break
    // out of brainDir). validateSourceId throws on `..`, `/`, etc.
    validateSourceId(source_id);
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    const tags = await engine.getTags(slug, { sourceId: source_id });
    try {
      const md = renderPageToMarkdown(page, tags);
      // v0.32.8 F6: non-default sources land under brainDir/.sources/<id>/<slug>.md
      // so same-slug-different-source pages don't collide on disk. Default-source
      // pages stay at brainDir/<slug>.md so single-source brains see no change.
      // `.sources/` is a reserved prefix; walkBrainRepo skips dot-dirs.
      const filePath = source_id === 'default'
        ? join(brainDir, `${slug}.md`)
        : join(brainDir, '.sources', source_id, `${slug}.md`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, md, 'utf8');
      count++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] reverse-write ${slug}@${source_id} failed: ${msg}\n`);
    }
  }
  return count;
}

function renderPageToMarkdown(page: Page, tags: string[]): string {
  const frontmatter = (page.frontmatter ?? {}) as Record<string, unknown>;
  return serializeMarkdown(
    frontmatter,
    page.compiled_truth ?? '',
    page.timeline ?? '',
    {
      type: (page.type as string) ?? 'note',
      title: page.title ?? '',
      tags,
    },
  );
}

// ── Status helpers ───────────────────────────────────────────────────

function ok(summary: string, details: Record<string, unknown> = {}): PhaseResult {
  return { phase: 'patterns', status: 'ok', duration_ms: 0, summary, details };
}

function skipped(reason: string, summary: string): PhaseResult {
  return {
    phase: 'patterns',
    status: 'skipped',
    duration_ms: 0,
    summary,
    details: { reason },
  };
}

function failed(error: PhaseError): PhaseResult {
  return {
    phase: 'patterns',
    status: 'fail',
    duration_ms: 0,
    summary: 'patterns phase failed',
    details: {},
    error,
  };
}

function makeError(cls: string, code: string, message: string, hint?: string): PhaseError {
  return hint ? { class: cls, code, message, hint } : { class: cls, code, message };
}
