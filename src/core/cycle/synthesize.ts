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
    if (!opts.inputFile && !config.enabled) {
      return skipped('not_configured',
        'dream.synthesize.enabled is false (set dream.synthesize.session_corpus_dir to enable)');
    }
    if (!opts.inputFile && !config.corpusDir) {
      return skipped('not_configured',
        'dream.synthesize.session_corpus_dir is unset');
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

    // Fan-out: submit one subagent per worth-processing transcript.
    const allowedSlugPrefixes = await loadAllowedSlugPrefixes();
    if (allowedSlugPrefixes.length === 0) {
      return failed(makeError('InternalError', 'NO_ALLOWLIST',
        'skills/_brain-filing-rules.json missing dream_synthesize_paths.globs'));
    }

    const queue = new MinionQueue(engine);
    const childIds: number[] = [];
    for (const t of worthProcessing) {
      const childData: SubagentHandlerData = {
        prompt: buildSynthesisPrompt(t),
        model: config.model,
        max_turns: 30,
        allowed_slug_prefixes: allowedSlugPrefixes,
      };
      const submitOpts: Partial<MinionJobInput> = {
        max_stalled: 3,
        on_child_fail: 'continue',
        idempotency_key: `dream:synth:${t.filePath}:${t.contentHash.slice(0, 16)}`,
        timeout_ms: 30 * 60 * 1000, // 30 min per transcript
      };
      const child = await queue.add(
        'subagent',
        childData as unknown as Record<string, unknown>,
        submitOpts,
        { allowProtectedSubmit: true },
      );
      childIds.push(child.id);
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
    const writtenSlugs = await collectChildPutPageSlugs(engine, childIds);

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
    return ok(`${worthProcessing.length} transcript(s) synthesized in ${(ms / 1000).toFixed(1)}s`, {
      transcripts_discovered: transcripts.length,
      transcripts_processed: worthProcessing.length,
      pages_written: writtenSlugs.length,
      reverse_write_count: reverseWriteCount,
      child_outcomes: childOutcomes,
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
}

async function loadSynthConfig(engine: BrainEngine): Promise<SynthConfig> {
  const enabled = (await engine.getConfig('dream.synthesize.enabled')) === 'true';
  const corpusDir = await engine.getConfig('dream.synthesize.session_corpus_dir');
  const meetingTranscriptsDir = await engine.getConfig('dream.synthesize.meeting_transcripts_dir');
  const minCharsStr = await engine.getConfig('dream.synthesize.min_chars');
  const excludeStr = await engine.getConfig('dream.synthesize.exclude_patterns');
  const model = (await engine.getConfig('dream.synthesize.model')) || 'claude-sonnet-4-6';
  const verdictModel = (await engine.getConfig('dream.synthesize.verdict_model')) || 'claude-haiku-4-5-20251001';
  const cooldownHoursStr = await engine.getConfig('dream.synthesize.cooldown_hours');

  let excludePatterns: string[] = ['medical', 'therapy'];
  if (excludeStr) {
    try {
      const parsed = JSON.parse(excludeStr);
      if (Array.isArray(parsed)) excludePatterns = parsed.filter(p => typeof p === 'string');
    } catch { /* keep default */ }
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

function buildSynthesisPrompt(t: DiscoveredTranscript): string {
  const dateHint = t.inferredDate ?? today();
  const hashSuffix = t.contentHash.slice(0, 6);
  const baseSlugSegment = sanitizeForSlug(t.basename) || `session-${dateHint}`;
  return `You are synthesizing a conversation transcript into the user's personal knowledge brain.

CONTEXT
- Today's date: ${dateHint}
- Transcript hash suffix (USE THIS in slugs): ${hashSuffix}
- Source file basename: ${baseSlugSegment}

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

TRANSCRIPT (${t.filePath})
---
${t.content}
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

// ── Slug collection from child put_page calls (codex #2) ────────────

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
