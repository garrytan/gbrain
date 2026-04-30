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
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult, PhaseError } from '../cycle.ts';
import { MinionQueue } from '../minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionJobInput, SubagentHandlerData } from '../minions/types.ts';
import { serializeMarkdown } from '../markdown.ts';
import type { Page, PageType } from '../types.ts';

export interface PatternsPhaseOpts {
  brainDir: string;
  dryRun: boolean;
  yieldDuringPhase?: () => Promise<void>;
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
    const reflections = await gatherReflections(engine, config.lookbackDays);
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

    // Submit one subagent for pattern detection.
    if (!process.env.ANTHROPIC_API_KEY) {
      return skipped('no_api_key', 'ANTHROPIC_API_KEY unset; pattern detection skipped');
    }

    const allowedSlugPrefixes = await loadAllowedSlugPrefixes();
    if (allowedSlugPrefixes.length === 0) {
      return failed(makeError('InternalError', 'NO_ALLOWLIST',
        'skills/_brain-filing-rules.json missing dream_synthesize_paths.globs'));
    }

    const queue = new MinionQueue(engine);
    const data: SubagentHandlerData = {
      prompt: buildPatternsPrompt(reflections, config.minEvidence),
      model: config.model,
      max_turns: 30,
      allowed_slug_prefixes: allowedSlugPrefixes,
    };
    const submitOpts: Partial<MinionJobInput> = {
      max_stalled: 3,
      timeout_ms: 30 * 60 * 1000,
    };
    const job = await queue.add('subagent', data as unknown as Record<string, unknown>, submitOpts, {
      allowProtectedSubmit: true,
    });

    let outcome: string;
    try {
      const final = await waitForCompletion(queue, job.id, {
        timeoutMs: 35 * 60 * 1000,
        pollMs: 5 * 1000,
      });
      outcome = final.status;
    } catch (e) {
      if (e instanceof TimeoutError) outcome = 'timeout';
      else throw e;
    }

    if (opts.yieldDuringPhase) {
      try { await opts.yieldDuringPhase(); } catch { /* best-effort */ }
    }

    // Collect slugs the subagent wrote (codex finding #2 — query tool exec rows).
    const writtenSlugs = await collectChildPutPageSlugs(engine, [job.id]);

    // Reverse-write to fs.
    const reverseWriteCount = await reverseWriteSlugs(engine, opts.brainDir, writtenSlugs);

    return ok(`${writtenSlugs.length} pattern page(s) written/updated (${outcome})`, {
      reflections_considered: reflections.length,
      patterns_written: writtenSlugs.length,
      reverse_write_count: reverseWriteCount,
      child_outcome: outcome,
      job_id: job.id,
    });
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
}

async function loadPatternsConfig(engine: BrainEngine): Promise<PatternsConfig> {
  const enabledStr = await engine.getConfig('dream.patterns.enabled');
  const enabled = enabledStr === null ? true : enabledStr === 'true';
  const lookbackStr = await engine.getConfig('dream.patterns.lookback_days');
  const minEvidenceStr = await engine.getConfig('dream.patterns.min_evidence');
  const model = (await engine.getConfig('dream.patterns.model')) || 'claude-sonnet-4-6';
  return {
    enabled,
    lookbackDays: lookbackStr ? Math.max(1, parseInt(lookbackStr, 10) || 30) : 30,
    minEvidence: minEvidenceStr ? Math.max(1, parseInt(minEvidenceStr, 10) || 3) : 3,
    model,
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
): Promise<ReflectionRef[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await engine.executeRaw<{ slug: string; title: string | null; compiled_truth: string | null }>(
    `SELECT slug, title, compiled_truth
       FROM pages
      WHERE slug LIKE 'wiki/personal/reflections/%'
        AND updated_at >= $1::timestamptz
      ORDER BY updated_at DESC
      LIMIT 100`,
    [since],
  );
  return rows.map(r => ({
    slug: r.slug,
    title: r.title ?? r.slug,
    excerpt: (r.compiled_truth ?? '').slice(0, 600),
  }));
}

// ── Prompt ────────────────────────────────────────────────────────────

function buildPatternsPrompt(reflections: ReflectionRef[], minEvidence: number): string {
  const today = new Date().toISOString().slice(0, 10);
  const corpus = reflections
    .map((r, i) => `### ${i + 1}. [[${r.slug}]] — ${r.title}\n${r.excerpt}`)
    .join('\n\n---\n\n');

  return `You are surfacing recurring themes across the user's recent reflections.

OUTPUT POLICY
- Only name a pattern if it appears in at least ${minEvidence} DISTINCT reflections.
- Each pattern page MUST cite the reflections that constitute its evidence (use [[wiki/personal/reflections/...]] wikilinks).
- Use \`search\` to check whether a similar pattern page already exists; if yes, update it (use the same slug). If no, create a new one.
- Pattern slug format: \`wiki/personal/patterns/<topic-slug>\` (lowercase alphanumeric + hyphens; no underscores, no extension, no date).
- A "pattern" is a recurring theme, anxiety, decision pattern, relationship dynamic, or self-knowledge motif. NOT a single insight. NOT a list of unrelated topics.

DO NOT WRITE
- A "patterns from today" digest (that's the dream-cycle-summaries page; not your job).
- Patterns with <${minEvidence} reflections cited.
- Anything outside wiki/personal/patterns/.

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
): Promise<string[]> {
  if (childIds.length === 0) return [];
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT input->>'slug' AS slug
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[])
        AND tool_name = 'brain_put_page'
        AND status = 'complete'
        AND input ? 'slug'
      ORDER BY 1`,
    [childIds],
  );
  return rows.map(r => r.slug).filter((s): s is string => typeof s === 'string' && s.length > 0);
}

// ── Reverse-write ────────────────────────────────────────────────────

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
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] reverse-write ${slug} failed: ${msg}\n`);
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
      type: (page.type as PageType) ?? 'note',
      title: page.title ?? '',
      tags,
    },
  );
}

// ── Allow-list (shared with synthesize.ts) ───────────────────────────

async function loadAllowedSlugPrefixes(): Promise<string[]> {
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
