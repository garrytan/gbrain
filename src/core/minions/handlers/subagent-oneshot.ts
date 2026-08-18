/**
 * #4216 — oneshot synthesis runner.
 *
 * Replaces the 10-25-round-trip agentic loop with ONE completion + programmatic
 * validated writes for dream-cycle synthesis jobs (`data.mode === 'oneshot'`):
 *
 *   1. Single tool-less chat call. The prompt already carries the
 *      pre-retrieval LINK CANDIDATES manifest + ALLOWED WRITE PATHS block
 *      (built at fan-out); the static ONESHOT_SYSTEM contract rides
 *      `cacheSystem` so consecutive jobs share the prompt-cache prefix.
 *   2. Strict validation BEFORE any write (all-or-nothing): JSON contract,
 *      slug grammar + allow-list + task shape + hash suffix (CDX-9 — the
 *      suffix is the idempotency boundary, never trusted to prompt
 *      discipline), exact-match wikilink rule (OV-1).
 *   3. Writes through the SAME brain_put_page tool executor the agentic loop
 *      uses (slug fences, trusted-workspace side effects, provenance all
 *      identical) with `deferEmbeds` — the embed network call leaves the
 *      model path entirely. Each write is bracketed by the standard
 *      tool-execution ledger rows under invocation-scoped ids
 *      (`oneshot-<inv8>-p<i>`), so slug collection, provenance stamping,
 *      reverse-writes and #4217 accounting all work unchanged.
 *   4. Any validation failure → `{kind:'fallback'}` and the SAME job falls
 *      through to the agentic loop (same prompt, same idempotency key).
 *
 * Crash safety (OV-4 ledger-first recovery): the runner only calls the model
 * when the job has NO oneshot ledger rows. A retried job that already wrote
 * (any invocation) finalizes from the ledger instead of re-calling a
 * nondeterministic model — no double-writes, no near-duplicate pages.
 * Transcript messages are persisted ONLY after success, so the
 * `alreadyTerminal` replay check can never replay a failed attempt's JSON as
 * a completed result.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext, SubagentHandlerData, SubagentResult, ToolDef, ContentBlock, OneshotFallbackReason } from '../types.ts';
import { chat as gatewayChat, type ChatResult } from '../../ai/gateway.ts';
import { parseLlmJson } from '../../llm-json.ts';
import { PAGE_SLUG_SEG } from '../../cjk.ts';
import { matchesSlugAllowList } from '../../ops/context.ts';
import { autoLinkWrittenPage } from '../../ops/pages.ts';
import { serializeMarkdown } from '../../markdown.ts';
import type { PageType } from '../../types.ts';
import { LINK_CANDIDATES_HEADER } from '../../cycle/link-manifest.ts';
import { acquireLease, releaseLease, RateLeaseUnavailableError } from '../rate-leases.ts';
import { isRetryableConnError } from '../../retry-matcher.ts';
import { logSubagentHeartbeat } from './subagent-audit.ts';
import {
  persistMessage,
  persistToolExecComplete,
  persistToolExecFailed,
} from './subagent-persistence.ts';

// The reason vocabulary is owned by ../types.ts (SubagentResult references
// it); re-exported here for the handler + tests.
export type { OneshotFallbackReason } from '../types.ts';

export type OneshotOutcome =
  | { kind: 'done'; result: SubagentResult }
  | {
      kind: 'fallback';
      reason: OneshotFallbackReason;
      /**
       * Usage of the PAID oneshot attempt, present on post-call fallbacks —
       * the handler merges it into the agentic result's rollup so
       * details.synthesis cost/turn math counts the attempt (absent on
       * pre-call fallbacks like no_put_page_tool, and on oneshot_timeout
       * where the provider returned no usage).
       */
      tokens?: { in: number; out: number; cache_read: number; cache_create: number };
    };

const SLUG_RE = new RegExp(`^${PAGE_SLUG_SEG}(\\/${PAGE_SLUG_SEG})*$`, 'u');
const MAX_PAGES_PER_RESPONSE = 12;
const ONESHOT_CALL_BUDGET_MS = 300_000;

/**
 * One constant for the three coupled sites: the ledger LIKE pattern, the
 * per-write id template, and subagent.ts's accounting scope prefix.
 */
export const ONESHOT_TOOL_USE_ID_PREFIX = 'oneshot-';

/**
 * Static system contract — deliberately free of per-job content so the
 * Anthropic prompt-cache breakpoint on the system block hits across every
 * oneshot job in a cycle.
 */
export const ONESHOT_SYSTEM = `You are a knowledge-synthesis engine. You have NO tools. Read the user message (task instructions + transcript) and respond with ONLY a JSON object — no prose before or after, no code fence — in exactly this shape:

{"pages": [{"slug": "<full slug obeying ALLOWED WRITE PATHS and the Task A/B templates, ending with the hash suffix from CONTEXT>",
            "title": "<short human title>",
            "type": "note",
            "body": "<markdown page body. MUST contain at least one wikilink like [[people/jane-doe]] whose target is taken from LINK CANDIDATES or is another page in this response. Follow every OUTPUT POLICY rule from the user message.>"}],
 "skipped": false,
 "skip_reason": null}

If nothing in the transcript meets the bar (Task D), respond with:
{"pages": [], "skipped": true, "skip_reason": "<one line>"}

Hard rules: at most ${MAX_PAGES_PER_RESPONSE} pages; slugs are lowercase, hyphen-separated, slash-delimited, no underscores, no file extensions; never invent wikilink targets that are not in LINK CANDIDATES or this response.`;

export interface OneshotPage {
  slug: string;
  title: string;
  type: string;
  body: string;
}

export interface ParsedOneshot {
  pages: OneshotPage[];
  skipped: boolean;
  skip_reason: string | null;
}

/**
 * R3-1: model-supplied frontmatter is REJECTED at parse time (stripped from
 * the body) rather than passed through to put_page. A leading YAML block
 * could otherwise smuggle an explicit `type: person` past the note pin, and
 * a wikilink living only inside the YAML would satisfy validation and then
 * vanish when parseMarkdown strips the frontmatter — validation must see
 * exactly the body that gets written.
 */
function stripLeadingFrontmatter(body: string): string {
  if (!body.startsWith('---\n')) return body;
  const close = body.indexOf('\n---', 4);
  if (close === -1) return body; // unterminated — plain text, serialize as-is
  const after = body.indexOf('\n', close + 4);
  return (after === -1 ? '' : body.slice(after + 1)).trimStart();
}

/** Tolerant parse + shape validation (no slug/link policy here — that needs job context). */
export function parseOneshotResponse(raw: string): ParsedOneshot | null {
  const parsed = parseLlmJson<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const pagesRaw = (parsed as { pages?: unknown }).pages;
  if (!Array.isArray(pagesRaw)) return null;
  const pages: OneshotPage[] = [];
  for (const p of pagesRaw) {
    if (!p || typeof p !== 'object') return null;
    const rec = p as Record<string, unknown>;
    if (typeof rec.slug !== 'string' || rec.slug.trim() === '') return null;
    if (typeof rec.body !== 'string') return null;
    const body = stripLeadingFrontmatter(rec.body);
    if (body.trim() === '') return null;
    pages.push({
      slug: rec.slug.trim(),
      title: typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : rec.slug.trim().split('/').pop()!,
      // F5 (adversarial): `type` is model-controlled and PageType is an open
      // string — pin to the contract's 'note' instead of letting the oneshot
      // lane author arbitrary type taxonomies. Field kept for shape-compat.
      type: 'note',
      body,
    });
  }
  const skipped = (parsed as { skipped?: unknown }).skipped === true;
  const skipReasonRaw = (parsed as { skip_reason?: unknown }).skip_reason;
  return {
    pages,
    skipped,
    skip_reason: typeof skipReasonRaw === 'string' ? skipReasonRaw : null,
  };
}

/**
 * Extract wikilink targets from a body: `[[slug]]` / `[[slug|alias]]` /
 * `[[slug#anchor]]` plus relative markdown links `[text](path/to-page)`
 * (the two forms the synthesis prompt teaches). http(s)/mailto links are not
 * page links.
 */
export function extractWikilinkTargets(body: string): string[] {
  const targets: string[] = [];
  const wikilink = /\[\[([^\]|#\n]+)(?:[|#][^\]]*)?\]\]/gu;
  for (const m of body.matchAll(wikilink)) {
    const t = m[1].trim();
    if (t) targets.push(t);
  }
  const mdLink = /\]\(((?!https?:\/\/|mailto:)[^()\s]+)\)/gu;
  for (const m of body.matchAll(mdLink)) {
    const t = m[1].trim().replace(/^\.\//, '').replace(/\.md$/, '');
    if (t && !t.startsWith('#')) targets.push(t);
  }
  return targets;
}

export interface OneshotArgs {
  engine: BrainEngine;
  ctx: MinionJobContext;
  data: SubagentHandlerData;
  model: string;
  maxOutputTokens: number;
  /** The deferEmbeds-enabled brain_put_page ToolDef (same executor as the loop). */
  putPageTool: ToolDef | undefined;
  leaseKey: string;
  maxConcurrent: number;
  leaseTtlMs: number;
  /** Test seam (extract-atoms pattern). */
  _chat?: typeof gatewayChat;
  /** Test seam: override the OV-9 sub-budget (default min(5min, deadline/4)). */
  _budgetMs?: number;
}

/**
 * Strict abort classification for the WRITE/recovery paths: name-only, so a
 * deterministic put_page failure whose message merely mentions a timeout
 * (PG `statement timeout`, a provider wrapper naming an upstream timeout)
 * settles 'failed' like any other write verdict instead of burning full job
 * attempts through pending-row recovery.
 */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

/**
 * Looser abort classification for the CHAT-call catch ONLY, where it is
 * additionally guarded by `budgetAbort.aborted` (so a message false-positive
 * cannot misroute anything unless the budget really expired). The message
 * match covers provider-SDK wrappers that rename the abort.
 */
function isAbortShaped(e: unknown): boolean {
  return isAbortError(e) || (e instanceof Error && /\babort|\btimed?[ _-]?out/i.test(e.message));
}

interface LedgerRow { tool_use_id: string; ordinal: number | null; status: string; slug: string | null; content: string | null }

async function loadOneshotLedger(engine: BrainEngine, jobId: number): Promise<LedgerRow[]> {
  return engine.executeRaw<LedgerRow>(
    `SELECT tool_use_id, ordinal, status, input->>'slug' AS slug, input->>'content' AS content
       FROM subagent_tool_executions
      WHERE job_id = $1 AND tool_use_id LIKE $2
      ORDER BY id`,
    [jobId, `${ONESHOT_TOOL_USE_ID_PREFIX}%`],
  );
}

export async function runSubagentOneshot(args: OneshotArgs): Promise<OneshotOutcome> {
  const { engine, ctx, data, model } = args;
  const chat = args._chat ?? gatewayChat;

  // ── OV-4: ledger-first recovery ─────────────────────────────────────────
  // A prior invocation of this job already reached the write stage. Never
  // re-call the model (nondeterministic output would double-write different
  // pages); the completed rows ARE the writes.
  const priorLedger = await loadOneshotLedger(engine, ctx.id);
  if (priorLedger.length > 0) {
    // Settle any PENDING rows first (crash between the pending bank and
    // the settle write). The ledger stores the exact input, and put_page is
    // an upsert, so re-executing is idempotent. Without this, a pending-only
    // ledger would finalize 'completed' with zero pages — the exact
    // completed-means-zero-pages class #4217 exists to kill (flagged
    // independently by two ship reviewers).
    for (const row of priorLedger) {
      if (row.status !== 'pending') continue;
      const input = { slug: row.slug ?? '', content: row.content ?? '' };
      if (!args.putPageTool || !input.slug || !input.content) {
        await persistToolExecFailed(engine, ctx.id, 1, row.ordinal ?? 0, row.tool_use_id, 'brain_put_page', input,
          'oneshot recovery: pending write could not be re-executed (missing tool or ledger input)');
        row.status = 'failed';
        continue;
      }
      try {
        const output = await args.putPageTool.execute(input, { engine, jobId: ctx.id, remote: true, signal: ctx.signal });
        await persistToolExecComplete(engine, ctx.id, 1, row.ordinal ?? 0, row.tool_use_id, output);
        row.status = 'complete';
      } catch (e) {
        // Abort (job cancel/timeout mid-recovery) and transient connection
        // errors are NOT write verdicts — rethrow and leave the row pending
        // so the next retry re-executes it, instead of freezing a permanent
        // 'failed' that could dead-letter perfectly writable content.
        if (ctx.signal?.aborted || isAbortError(e) || isRetryableConnError(e)) throw e;
        await persistToolExecFailed(engine, ctx.id, 1, row.ordinal ?? 0, row.tool_use_id, 'brain_put_page', input,
          e instanceof Error ? e.message : String(e));
        row.status = 'failed';
      }
    }
    const writtenRefs = priorLedger
      .filter(r => r.status === 'complete' || r.status === 'failed')
      .map(r => ({ slug: r.slug ?? '', status: (r.status === 'complete' ? 'complete' : 'failed') as 'complete' | 'failed' }))
      .filter(r => r.slug !== '');
    // A crash AFTER the write loop but before/during the post-batch
    // auto-link pass would otherwise permanently drop the in-batch forward
    // edges (CEO-1) for recovered jobs — replay the same gated, best-effort
    // pass here from the ledger's stored bodies.
    const recoveredSlugs = new Set(writtenRefs.filter(r => r.status === 'complete').map(r => r.slug));
    for (const row of priorLedger) {
      if (row.status !== 'complete' || !row.slug || !row.content) continue;
      const targets = extractWikilinkTargets(row.content);
      if (!targets.some(t => recoveredSlugs.has(t) && t !== row.slug)) continue;
      await autoLinkWrittenPage(engine, row.slug, { sourceId: data.source_id ?? 'default' });
    }
    const recoveredText = `oneshot recovery: finalized from a prior invocation's ledger (${writtenRefs.filter(r => r.status === 'complete').length} completed write(s))`;
    await persistOneshotTranscript(engine, ctx.id, data.prompt, recoveredText, model);
    return {
      kind: 'done',
      result: {
        result: recoveredText,
        turns_count: 1,
        stop_reason: 'end_turn',
        tokens: { in: 0, out: 0, cache_read: 0, cache_create: 0 },
        synth_mode_used: 'oneshot',
        written_refs: writtenRefs,
        recovered: true,
      },
    };
  }

  if (!args.putPageTool) {
    // No put_page in the registry (misconfigured allow-list) — a config
    // error, not a model failure; distinct reason so telemetry separates it.
    return { kind: 'fallback', reason: 'no_put_page_tool' };
  }

  // ── Single provider call under a rate lease + sub-budget (OV-9) ─────────
  const budgetMs = args._budgetMs ?? (ctx.deadlineAtMs
    ? Math.min(ONESHOT_CALL_BUDGET_MS, Math.max(30_000, Math.floor((ctx.deadlineAtMs - Date.now()) / 4)))
    : ONESHOT_CALL_BUDGET_MS);
  // Lease TTL must OUTLIVE the call it guards: the sub-budget hard-bounds
  // the call (AbortSignal.timeout below), so ttl = budget + slack. With the
  // bare 120s default TTL a 300s call's lease would be pruned mid-flight and
  // the next acquirer would over-admit past maxConcurrent.
  const lease = await acquireLease(engine, args.leaseKey, ctx.id, args.maxConcurrent, {
    ttlMs: Math.max(args.leaseTtlMs, budgetMs + 30_000),
  });
  if (!lease.acquired) {
    // A full bucket is a scheduling condition, not a model failure — throw
    // RateLeaseUnavailableError so the worker / inline drain requeue the job
    // WITHOUT burning an attempt (never fall back: the fallback would hit
    // the same full bucket sixteen times over).
    throw new RateLeaseUnavailableError(args.leaseKey, lease.activeCount, lease.maxConcurrent);
  }
  const budgetAbort = AbortSignal.timeout(budgetMs);
  const callSignal = ctx.signal ? AbortSignal.any([ctx.signal, budgetAbort]) : budgetAbort;

  let chatResult: ChatResult;
  const t0 = Date.now();
  logSubagentHeartbeat({ job_id: ctx.id, event: 'llm_call_started', turn_idx: 0, mode: 'oneshot' });
  try {
    chatResult = await chat({
      model,
      system: ONESHOT_SYSTEM,
      messages: [{ role: 'user', content: data.prompt }],
      maxTokens: args.maxOutputTokens,
      abortSignal: callSignal,
      // cacheSystem marks the system block as a cache breakpoint. Note:
      // ONESHOT_SYSTEM alone is under Anthropic's ~1024-token cache minimum,
      // so cross-job prefix hits only materialize on providers/models with a
      // lower floor — harmless no-op otherwise.
      cacheSystem: true,
    });
  } catch (err) {
    if (budgetAbort.aborted && !(ctx.signal?.aborted) && isAbortShaped(err)) {
      // The oneshot sub-budget expired — the agentic fallback still has the
      // rest of the job budget (OV-9). Never charge a slow single call
      // against the whole job.
      logSubagentHeartbeat({ job_id: ctx.id, event: 'oneshot_timeout', turn_idx: 0, ms_elapsed: Date.now() - t0 });
      return { kind: 'fallback', reason: 'oneshot_timeout' };
    }
    // Job-level abort or transport error: the job machinery owns these — a
    // provider outage would break the fallback identically (don't double-pay).
    throw err;
  } finally {
    await releaseLease(engine, lease.leaseId!).catch(() => { /* best-effort */ });
  }

  await ctx.updateTokens({
    input: chatResult.usage.input_tokens,
    output: chatResult.usage.output_tokens,
    cache_read: chatResult.usage.cache_read_tokens,
  });
  const tokens = {
    in: chatResult.usage.input_tokens,
    out: chatResult.usage.output_tokens,
    cache_read: chatResult.usage.cache_read_tokens,
    cache_create: chatResult.usage.cache_creation_tokens,
  };
  logSubagentHeartbeat({ job_id: ctx.id, event: 'llm_call_completed', turn_idx: 0, tokens: { in: tokens.in, out: tokens.out, cache_read: tokens.cache_read, cache_create: tokens.cache_create } });

  // Post-call fallbacks carry the attempt's usage for the result rollup.
  const fb = (reason: OneshotFallbackReason): OneshotOutcome => ({ kind: 'fallback', reason, tokens });

  // ── Degenerate-output discipline (judgeSignificance parity) ─────────────
  if (chatResult.stopReason === 'length') return fb('length');
  if (chatResult.stopReason === 'refusal' || chatResult.stopReason === 'content_filter') {
    return fb('refusal');
  }

  const parsed = parseOneshotResponse(chatResult.text ?? '');
  if (!parsed) return fb('unparseable');
  if (parsed.pages.length === 0) {
    if (!parsed.skipped) return fb('empty_no_skip');
    // Task-D skip: a legitimate zero-write completion.
    const skipText = `oneshot: nothing met the bar — ${parsed.skip_reason ?? 'no reason given'}`;
    await persistOneshotTranscript(engine, ctx.id, data.prompt, chatResult.text ?? skipText, model, tokens);
    return {
      kind: 'done',
      result: {
        result: skipText,
        turns_count: 1,
        stop_reason: 'end_turn',
        tokens,
        synth_mode_used: 'oneshot',
        written_refs: [],
      },
    };
  }
  if (parsed.pages.length > MAX_PAGES_PER_RESPONSE) return fb('too_many_pages');

  // ── Validate ALL pages before ANY write ─────────────────────────────────
  const prefixes = data.allowed_slug_prefixes ?? [];
  // CDX-9 task shapes: reflections/originals sub-trees of the allow-list.
  const taskShapePrefixes = prefixes
    .filter(p => p.includes('/personal/reflections/') || p.includes('/originals/'))
    .map(p => (p.endsWith('/*') ? p.slice(0, -1) : p.endsWith('/') ? p : `${p}/`));
  const inBatch = new Set(parsed.pages.map(p => p.slug));
  // Duplicate slugs inside one batch would make the second write silently
  // overwrite the first while both report complete — reject the batch
  // (all-or-nothing contract).
  if (inBatch.size !== parsed.pages.length) return fb('bad_slug');
  // Targeted membership probe instead of materializing the whole slug set
  // (getAllSlugs is a full-table scan per job; wikilink targets are few).
  // Reads are scoped to the WRITE's source (source_id ?? 'default' — mirrors
  // putPage's schema default) so validation universe == write universe.
  const writeSourceId = data.source_id ?? 'default';
  const allTargets = [...new Set(parsed.pages.flatMap(p => extractWikilinkTargets(p.body)))];
  let existingSlugs: Set<string>;
  let pageSample = 0;
  try {
    const rows = allTargets.length > 0
      ? await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages WHERE slug = ANY($1) AND source_id = $2 AND deleted_at IS NULL`,
          [allTargets, writeSourceId],
        )
      : [];
    existingSlugs = new Set(rows.map(r => r.slug));
    const sample = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM pages WHERE source_id = $1 AND deleted_at IS NULL LIMIT 5) t`,
      [writeSourceId],
    );
    pageSample = sample[0]?.n ?? 0;
  } catch {
    existingSlugs = new Set();
    pageSample = 5; // fail toward strict validation, not toward cold-brain leniency
  }
  // CEO-5 cold-brain relaxation: no manifest was offered AND the brain has
  // almost no pages — a resolving wikilink is impossible; accept syntactic
  // presence (content-first; the edge materializes once targets exist).
  const coldBrain = pageSample < 5 && !data.prompt.includes(LINK_CANDIDATES_HEADER);

  for (const page of parsed.pages) {
    if (!SLUG_RE.test(page.slug)) return fb('bad_slug');
    if (prefixes.length > 0 && !matchesSlugAllowList(page.slug, prefixes)) {
      return fb('bad_slug');
    }
    if (taskShapePrefixes.length > 0 && !taskShapePrefixes.some(p => page.slug.startsWith(p))) {
      // Oneshot synthesis writes ONLY reflections/originals (Task C forbids
      // touching person pages; the orchestrator owns people enrichment).
      return fb('bad_slug');
    }
    if (data.oneshot_slug_suffix && !page.slug.endsWith(`-${data.oneshot_slug_suffix}`)) {
      return fb('bad_slug');
    }
    const targets = extractWikilinkTargets(page.body);
    if (targets.length === 0) return fb('no_wikilink');
    if (!coldBrain) {
      const resolves = targets.some(t => existingSlugs.has(t) || (inBatch.has(t) && t !== page.slug));
      if (!resolves) return fb('no_wikilink');
    }
  }

  // ── Programmatic writes through the shared put_page executor ────────────
  const inv8 = randomUUID().replace(/-/g, '').slice(0, 8);
  const plannedWrites = parsed.pages.map((page, i) => {
    // ALWAYS serialize with the pinned type + parsed title — model-supplied
    // frontmatter was stripped at parse time (R3-1), so no body can smuggle
    // its own keys past normalization.
    const content = serializeMarkdown({}, page.body, '', { type: page.type as PageType, title: page.title, tags: [] });
    return { toolUseId: `${ONESHOT_TOOL_USE_ID_PREFIX}${inv8}-p${i}`, input: { slug: page.slug, content } };
  });
  // Bank the WHOLE batch as pending in ONE transaction BEFORE the first
  // write executes. Interleaved pending/execute would let a crash mid-batch
  // leave a truncated ledger, and recovery would then finalize 'completed'
  // with the tail of the batch silently lost (the idempotency key is
  // consumed — no future cycle rewrites it). Atomic banking makes recovery's
  // universe all-or-nothing: either every page is re-executable or none was
  // started. Same $N::text::jsonb discipline as persistToolExecPending.
  await engine.transaction(async (tx) => {
    for (let i = 0; i < plannedWrites.length; i++) {
      const w = plannedWrites[i];
      // ordinal = page index: row identity is (job_id, message_idx, ordinal)
      // post-v131 (the job-wide tool_use_id unique is gone), and oneshot ids
      // are invocation-unique anyway.
      await tx.executeRaw(
        `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, ordinal)
         VALUES ($1, 1, $2, 'brain_put_page', $3::text::jsonb, 'pending', $4)
         ON CONFLICT (job_id, message_idx, ordinal) DO NOTHING`,
        [ctx.id, w.toolUseId, JSON.stringify(w.input), i],
      );
    }
  });
  const writtenRefs: Array<{ slug: string; status: 'complete' | 'failed' }> = [];
  for (let i = 0; i < parsed.pages.length; i++) {
    const page = parsed.pages[i];
    const { toolUseId, input } = plannedWrites[i];
    // A cancelled job must stop writing and rethrow — the banked pending
    // rows make the retry's recovery re-execute the remainder. Converting a
    // cancellation into permanent 'failed' rows would complete the job with
    // a silently lost tail under a consumed idempotency key.
    if (ctx.signal?.aborted) throw new DOMException('oneshot write loop aborted by job signal', 'AbortError');
    let output: unknown;
    try {
      output = await args.putPageTool.execute(input, {
        engine,
        jobId: ctx.id,
        remote: true,
        signal: ctx.signal,
      });
    } catch (e) {
      // Abort/transient-conn errors are not write verdicts (same rule as
      // recovery): rethrow, row stays pending, retry re-executes.
      if (ctx.signal?.aborted || isAbortError(e) || isRetryableConnError(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      await persistToolExecFailed(engine, ctx.id, 1, i, toolUseId, 'brain_put_page', input, msg);
      writtenRefs.push({ slug: page.slug, status: 'failed' });
      continue;
    }
    try {
      await persistToolExecComplete(engine, ctx.id, 1, i, toolUseId, output);
    } catch (e) {
      // The PAGE COMMITTED but the ledger settle failed. Never settle
      // 'failed' here — the page would exist while provenance/reverse-write
      // /accounting exclude it. Rethrow: the row stays pending and recovery
      // re-executes the idempotent upsert, then settles complete.
      throw e instanceof Error ? e : new Error(String(e));
    }
    writtenRefs.push({ slug: page.slug, status: 'complete' });
  }

  // ── Post-batch auto-link pass (CEO-1/CDX-11) ─────────────────────────────
  // In-batch forward references (page A → page B written later) were dropped
  // by A's own auto-link run because B did not exist yet. Re-run ONLY for
  // pages that actually reference an in-batch sibling — re-running for every
  // page would double the auto-link work (full slug scan + tx each) for the
  // common no-forward-refs case. Gated + best-effort inside the wrapper.
  for (let i = 0; i < parsed.pages.length; i++) {
    const ref = writtenRefs[i];
    if (!ref || ref.status !== 'complete') continue;
    const targets = extractWikilinkTargets(parsed.pages[i].body);
    if (!targets.some(t => inBatch.has(t) && t !== parsed.pages[i].slug)) continue;
    await autoLinkWrittenPage(engine, ref.slug, { sourceId: writeSourceId });
  }

  const written = writtenRefs.filter(r => r.status === 'complete');
  const resultText = `oneshot: wrote ${written.length}/${parsed.pages.length} page(s): ${written.map(r => r.slug).join(', ')}`;
  await persistOneshotTranscript(engine, ctx.id, data.prompt, chatResult.text ?? resultText, model, tokens);

  return {
    kind: 'done',
    result: {
      result: resultText,
      turns_count: 1,
      stop_reason: 'end_turn',
      tokens,
      synth_mode_used: 'oneshot',
      written_refs: writtenRefs,
    },
  };
}

/**
 * Persist the seed user + terminal assistant turns — ONLY on success paths
 * (done/skip/recovery). A failed attempt persists nothing, so the
 * alreadyTerminal replay check can never return its output as a completed
 * job, and CDX-2's fresh-job gate stays accurate for the fallback.
 */
async function persistOneshotTranscript(
  engine: BrainEngine,
  jobId: number,
  prompt: string,
  assistantText: string,
  model: string,
  tokens?: { in: number; out: number; cache_read: number; cache_create: number },
): Promise<void> {
  await persistMessage(engine, jobId, {
    message_idx: 0,
    role: 'user',
    content_blocks: [{ type: 'text', text: prompt }] as ContentBlock[],
    tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_create: null,
    model: null,
  });
  await persistMessage(engine, jobId, {
    message_idx: 1,
    role: 'assistant',
    content_blocks: [{ type: 'text', text: assistantText }] as ContentBlock[],
    tokens_in: tokens?.in ?? null,
    tokens_out: tokens?.out ?? null,
    tokens_cache_read: tokens?.cache_read ?? null,
    tokens_cache_create: tokens?.cache_create ?? null,
    model,
  });
}
