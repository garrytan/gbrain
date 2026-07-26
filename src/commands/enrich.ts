/**
 * gbrain enrich — batch enrichment primitive (issue #1700).
 *
 * 93.6% of people/company pages are stubs. There was no first-class way to
 * develop them at scale — you drove the agent-only `enrich` SKILL one page at a
 * time, or hand-rolled SQL + a bash fan-out. This command closes that gap with
 * BRAIN-INTERNAL GROUNDED SYNTHESIS:
 *
 *   1. `engine.listEnrichCandidates` enumerates thin pages, ordered by inbound
 *      links (the headline signal — most-referenced stubs first), source-aware
 *      and memory-bounded (lightweight projection, no bodies).
 *   2. For each candidate, deterministically retrieve everything the brain
 *      ALREADY knows about the entity (hybrid search on its name, inbound-link
 *      context, facts, the existing stub) — no web, no external tools.
 *   3. One grounded LLM call consolidates that context into a real, cited page.
 *      If the brain knows too little, SKIP rather than fabricate.
 *
 * Why brain-internal: gbrain's own LLM tooling can only see brain tools
 * (search/get_page/facts). External research (web/LinkedIn/Perplexity) is a
 * host-agent capability and stays the agent-driven `enrich` SKILL's job.
 *
 * Resumable (op-checkpoint), budget-capped (best-effort under --workers; pin
 * --workers 1 for an exact ceiling), per-page advisory-locked (no double-spend
 * across parallel workers / processes), and parallel (--workers K).
 *
 * Architecture mirrors `extract-conversation-facts.ts` (the closest precedent):
 * strict per-source core, optional externally-managed BudgetTracker, string-
 * encoded op-checkpoint resume state, and a `--background` Minion path that
 * fans out one job per source when --source is omitted.
 */

import type { BrainEngine } from '../core/engine.ts';
import type { EnrichCandidate, PageType } from '../core/types.ts';
import { operations } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';
import { isAvailable, chat, getChatModel, withBudgetTracker } from '../core/ai/gateway.ts';
import { BudgetTracker, BudgetExhausted } from '../core/budget/budget-tracker.ts';
import { hybridSearch } from '../core/search/hybrid.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { listSources } from '../core/sources-ops.ts';
import {
  loadOpCheckpoint,
  recordCompleted,
  clearOpCheckpoint,
  fingerprint,
  type OpCheckpointKey,
} from '../core/op-checkpoint.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions, maybeBackground } from '../core/cli-options.ts';
import { loadConfig } from '../core/config.ts';
import { runSlidingPool } from '../core/worker-pool.ts';
import { parseWorkers, resolveWorkersWithClamp } from '../core/sync-concurrency.ts';
import { withRefreshingLock, LockUnavailableError } from '../core/db-lock.ts';
import {
  DEFAULT_THIN_THRESHOLD,
  MIN_CONTEXT_CHARS,
  inferEnrichKind,
  renderEvidence,
  assessGrounding,
  buildEnrichPrompt,
  parseSynthesis,
  type EnrichEvidence,
} from '../core/enrich/thin.ts';

// ---------------------------------------------------------------------------
// Tunables (exported for tests).
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 50;
export const DEFAULT_TYPES: PageType[] = ['person', 'company'];
export const DEFAULT_MAX_COST_USD = 5.0;
/** Default re-enrich window: skip pages enriched within the last 30 days. */
export const DEFAULT_REENRICH_DAYS = 30;
/** Per-page advisory lock TTL. withRefreshingLock refreshes at 1/6 the TTL. */
export const PER_PAGE_LOCK_TTL_MINUTES = 2;
export const CHECKPOINT_OP = 'enrich';
/** Frontmatter provenance marker. Survives put_page write-through (which only
 *  overrides ingested_via / ingested_at / source_kind). */
export const ENRICHED_BY = 'cli:enrich';
/** Retrieval fan-out caps (keep evidence bounded). */
export const HYBRID_SEARCH_LIMIT = 8;
export const BACKLINK_LIMIT = 12;
export const FACT_LIMIT = 20;
/** Flush the resume checkpoint every N completions during a long run. */
const CHECKPOINT_FLUSH_EVERY = 25;
/** Rough per-page cost estimate (USD) for the dry-run preview. */
const COST_ESTIMATE_PER_PAGE_USD = 0.01;

export const ENRICH_ORDERS = ['inbound-links', 'salience', 'updated'] as const;
export type EnrichOrder = (typeof ENRICH_ORDERS)[number];

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * DI seam for hermetic tests. Returns the model's raw synthesis text.
 * Default implementation calls the gateway; tests inject a stub so the full
 * pipeline runs with no API key (and stays parallel-safe — no mock.module).
 */
export type SynthesizeFn = (input: {
  system: string;
  user: string;
  model: string;
  abortSignal?: AbortSignal;
}) => Promise<string>;

/** Strict per-source core opts. Multi-source iteration is the caller's job. */
export interface EnrichCoreOpts {
  /** REQUIRED. Strict per-source contract. */
  sourceId: string;
  types?: PageType[];
  order?: EnrichOrder;
  limit?: number;
  /** In-process parallel workers. Default 1; PGLite clamps to 1. */
  workers?: number;
  /** Chat model override (provider:model). Default = configured chat model. */
  model?: string;
  /** Body char-length below which a page is "thin". */
  thinThreshold?: number;
  /** Minimum retrieved-context chars to attempt synthesis (no LLM below it). */
  minContextChars?: number;
  /** Skip pages enriched within this many ms. Default DEFAULT_REENRICH_DAYS. */
  reenrichAfterMs?: number;
  /** Cost cap (USD) when budgetTracker is NOT passed. Default DEFAULT_MAX_COST_USD. */
  maxCostUsd?: number;
  /** Externally-managed tracker. If present, used as-is (no withBudgetTracker wrap). */
  budgetTracker?: BudgetTracker;
  /** Preview only: count candidates + grounding decisions; no LLM, no write. */
  dryRun?: boolean;
  /** Clear this source's resume checkpoint before processing. */
  force?: boolean;
  /** Test seam — inject synthesis so tests skip the real gateway. */
  synthesizeFn?: SynthesizeFn;
}

export interface EnrichResult {
  candidates_considered: number;
  pages_enriched: number;
  /** Skipped because the brain knew too little (pre-LLM gate OR model SKIP). */
  pages_skipped_insufficient: number;
  /** Skipped because another worker/process held the per-page lock. */
  pages_skipped_lock: number;
  /** Skipped because the page disappeared between enumeration and fetch. */
  pages_skipped_disappeared: number;
  /** Synthesis or write errors (best-effort; pool continued). */
  pages_failed: number;
  /** Dry-run only: candidates that WOULD be enriched (passed grounding). */
  would_enrich?: number;
  spent_usd?: number;
  budget_exhausted?: boolean;
}

// ---------------------------------------------------------------------------
// Fingerprint — dimensions that change the candidate set OR the synthesis.
// Local to this command (matches the extract-conversation-facts precedent;
// no op-checkpoint.ts coupling). Source + types + order + thinThreshold +
// model: a change in any of these is a genuinely different run.
// ---------------------------------------------------------------------------

export function enrichFingerprint(opts: {
  sourceId: string;
  types: PageType[];
  order: EnrichOrder;
  thinThreshold: number;
  model: string;
}): string {
  return fingerprint({
    sourceId: opts.sourceId,
    types: [...opts.types].sort(),
    order: opts.order,
    thinThreshold: opts.thinThreshold,
    model: opts.model,
  });
}

function checkpointKey(fp: string): OpCheckpointKey {
  return { op: CHECKPOINT_OP, fingerprint: fp };
}

function completedKey(sourceId: string, slug: string): string {
  return `${sourceId}|${slug}`;
}

// ---------------------------------------------------------------------------
// Default synthesis via the gateway.
// ---------------------------------------------------------------------------

const defaultSynthesize: SynthesizeFn = async ({ system, user, model, abortSignal }) => {
  const res = await chat({
    model,
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2048,
    abortSignal,
    cacheSystem: true,
  });
  return res.text;
};

// ---------------------------------------------------------------------------
// Retrieval — deterministic, brain-internal. No LLM.
// ---------------------------------------------------------------------------

async function retrieveEvidence(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  title: string,
): Promise<EnrichEvidence[]> {
  const evidence: EnrichEvidence[] = [];
  const seen = new Set<string>();

  // 1. Hybrid search on the entity name — pages that mention it.
  try {
    const hits = await hybridSearch(engine, title || slug, {
      limit: HYBRID_SEARCH_LIMIT,
      sourceId,
    });
    for (const h of hits) {
      if (h.slug === slug) continue; // don't feed the stub its own body twice
      const dedup = `${h.slug}:${h.chunk_text.slice(0, 40)}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      if (h.chunk_text && h.chunk_text.trim()) {
        evidence.push({ source_slug: h.slug, text: h.chunk_text });
      }
    }
  } catch {
    // Search unavailable (no embeddings) → fall through to other signals.
  }

  // 2. Inbound-link context — how OTHER pages describe this entity.
  try {
    const backlinks = await engine.getBacklinks(slug, { sourceId });
    let n = 0;
    for (const l of backlinks) {
      if (n >= BACKLINK_LIMIT) break;
      const ctx = (l.context ?? '').trim();
      if (!ctx) continue;
      const dedup = `${l.from_slug}:${ctx.slice(0, 40)}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      evidence.push({ source_slug: l.from_slug, text: ctx });
      n++;
    }
  } catch {
    // ignore
  }

  // 3. Facts the brain has extracted about this entity.
  try {
    const rows = await engine.executeRaw<{ fact: string; context: string | null }>(
      `SELECT fact, context FROM facts
        WHERE source_id = $1 AND entity_slug = $2 AND expired_at IS NULL
        ORDER BY confidence DESC, id DESC
        LIMIT $3`,
      [sourceId, slug, FACT_LIMIT],
    );
    for (const r of rows) {
      const text = r.context ? `${r.fact} (${r.context})` : r.fact;
      evidence.push({ source_slug: slug, text });
    }
  } catch {
    // Pre-facts brains / column drift → no facts evidence.
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Per-page enrich (runs inside the worker pool, under a per-page lock).
// ---------------------------------------------------------------------------

interface EnrichOneCtx {
  engine: BrainEngine;
  sourceId: string;
  model: string;
  minContextChars: number;
  dryRun: boolean;
  synthesizeFn: SynthesizeFn;
  result: EnrichResult;
  done: Set<string>;
  signal?: AbortSignal;
  config: ReturnType<typeof loadConfig>;
}

async function enrichOne(ctx: EnrichOneCtx, candidate: EnrichCandidate): Promise<void> {
  const { engine, sourceId } = ctx;
  const slug = candidate.slug;
  const lockId = `enrich:${sourceId}:${slug}`;

  try {
    await withRefreshingLock(
      engine,
      lockId,
      () => enrichOneLocked(ctx, candidate),
      { ttlMinutes: PER_PAGE_LOCK_TTL_MINUTES },
    );
  } catch (err) {
    if (err instanceof LockUnavailableError) {
      ctx.result.pages_skipped_lock++;
      return; // page stays in backlog; next run retries
    }
    throw err; // BudgetExhausted (aborts pool) + real errors → pool failures[]
  }
}

async function enrichOneLocked(ctx: EnrichOneCtx, candidate: EnrichCandidate): Promise<void> {
  const { engine, sourceId } = ctx;
  const slug = candidate.slug;

  const page = await engine.getPage(slug, { sourceId });
  if (!page) {
    ctx.result.pages_skipped_disappeared++;
    return;
  }

  const kind = inferEnrichKind(page.type, slug);
  const evidence = await retrieveEvidence(engine, sourceId, slug, page.title || slug);
  const rendered = renderEvidence(evidence);
  const grounding = assessGrounding(rendered, ctx.minContextChars);

  if (!grounding.grounded) {
    ctx.result.pages_skipped_insufficient++;
    if (!ctx.dryRun) ctx.done.add(completedKey(sourceId, slug));
    return;
  }

  if (ctx.dryRun) {
    ctx.result.would_enrich = (ctx.result.would_enrich ?? 0) + 1;
    return; // no LLM, no write, no checkpoint advance
  }

  const { system, user } = buildEnrichPrompt({
    slug,
    title: page.title || slug,
    kind,
    currentBody: page.compiled_truth ?? '',
    evidence,
  });

  // `ctx.signal` is the CALLER's abort signal (shutdown / cancel). It is NOT the
  // sliding pool's internal budget-abort signal: runSlidingPool aborts its own
  // controller on BUDGET_EXHAUSTED but does not thread it into onItem, so an
  // already-running synth here is NOT cancelled when a sibling worker hits the
  // cap. That is the documented best-effort posture (overshoot ~1 call/worker
  // under --workers > 1; pin --workers 1 for a hard ceiling). A true in-flight
  // cancel would require a shared runSlidingPool API change (used by embed/eval).
  const raw = await ctx.synthesizeFn({ system, user, model: ctx.model, abortSignal: ctx.signal });
  const parsed = parseSynthesis(raw);
  if (parsed.skip || !parsed.body.trim()) {
    ctx.result.pages_skipped_insufficient++;
    ctx.done.add(completedKey(sourceId, slug));
    return;
  }

  // Write via the put_page op handler (trusted local: remote=false) so
  // auto-link + disk write-through fire, exactly like `gbrain capture`. The
  // retrieved context was sanitized in buildEnrichPrompt; the synthesized body
  // is the model's grounded output.
  const tags = await engine.getTags(slug, { sourceId }).catch(() => [] as string[]);
  const newFrontmatter: Record<string, unknown> = {
    ...page.frontmatter,
    // Provenance survives write-through (it only overrides ingested_via /
    // ingested_at / source_kind). enriched_at also drives the recency guard.
    enriched_at: new Date().toISOString(),
    enriched_by: ENRICHED_BY,
  };
  const content = serializeMarkdown(newFrontmatter, parsed.body, page.timeline ?? '', {
    type: page.type,
    title: page.title,
    tags,
  });

  const putPageOp = operations.find((o) => o.name === 'put_page');
  if (!putPageOp) throw new Error('put_page operation missing (gbrain build issue)');
  const opCtx: OperationContext = {
    engine,
    config: ctx.config ?? { engine: 'pglite' as const },
    logger: {
      info: () => {},
      warn: (msg: string) => process.stderr.write(`[enrich] WARN: ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[enrich] ERROR: ${msg}\n`),
    },
    dryRun: false,
    remote: false,
    sourceId,
  };
  await putPageOp.handler(opCtx, { slug, content });

  ctx.result.pages_enriched++;
  ctx.done.add(completedKey(sourceId, slug));
}

// ---------------------------------------------------------------------------
// Core (single source).
// ---------------------------------------------------------------------------

export async function runEnrichCore(
  engine: BrainEngine,
  opts: EnrichCoreOpts,
  signal?: AbortSignal,
): Promise<EnrichResult> {
  if (!opts.sourceId) throw new Error('runEnrichCore: opts.sourceId is required');

  const result: EnrichResult = {
    candidates_considered: 0,
    pages_enriched: 0,
    pages_skipped_insufficient: 0,
    pages_skipped_lock: 0,
    pages_skipped_disappeared: 0,
    pages_failed: 0,
  };

  const sourceId = opts.sourceId;
  const types = opts.types && opts.types.length > 0 ? opts.types : DEFAULT_TYPES;
  const order: EnrichOrder = ENRICH_ORDERS.includes(opts.order as EnrichOrder)
    ? (opts.order as EnrichOrder)
    : 'inbound-links';
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const thinThreshold = opts.thinThreshold ?? DEFAULT_THIN_THRESHOLD;
  const minContextChars = opts.minContextChars ?? MIN_CONTEXT_CHARS;
  const reenrichAfterMs = opts.reenrichAfterMs ?? DEFAULT_REENRICH_DAYS * 86_400_000;
  const model = opts.model || getChatModel();
  const dryRun = !!opts.dryRun;
  const synthesizeFn = opts.synthesizeFn ?? defaultSynthesize;
  const config = loadConfig();

  const workersResolved = resolveWorkersWithClamp(engine, opts.workers, 'enrich', 0);
  const workers = workersResolved.workers;

  // Candidate enumeration — ONE source-aware, memory-bounded SQL query.
  const candidates = await engine.listEnrichCandidates({
    types,
    sourceId,
    thinThreshold,
    order,
    limit,
    reenrichAfterMs,
  });
  result.candidates_considered = candidates.length;
  if (candidates.length === 0) return result;

  const fp = enrichFingerprint({ sourceId, types, order, thinThreshold, model });
  const cpKey = checkpointKey(fp);

  const body = async () => {
    if (opts.force) await clearOpCheckpoint(engine, cpKey);
    const done = new Set<string>(opts.force ? [] : await loadOpCheckpoint(engine, cpKey));

    // Filter out already-completed candidates (resume).
    const pending = candidates.filter((c) => !done.has(completedKey(sourceId, c.slug)));

    const oneCtx: EnrichOneCtx = {
      engine,
      sourceId,
      model,
      minContextChars,
      dryRun,
      synthesizeFn,
      result,
      done,
      signal,
      config,
    };

    let lastFlush = 0;
    let pool;
    try {
      pool = await runSlidingPool<EnrichCandidate>({
      items: pending,
      workers,
      signal,
      failureLabel: (c) => c.slug,
      onItem: async (c) => {
        await enrichOne(oneCtx, c);
        // Periodic checkpoint flush so a crash mid-run doesn't lose progress.
        if (!dryRun && done.size - lastFlush >= CHECKPOINT_FLUSH_EVERY) {
          lastFlush = done.size;
          await recordCompleted(engine, cpKey, [...done]);
        }
      },
      });
    } catch (err) {
      // P2#1 (codex): BudgetExhausted aborts the pool and propagates. Flush the
      // pages completed since the last 25-item flush BEFORE it bubbles to
      // runEnrichCore's catch, else resume re-charges them (and SKIP pages stay
      // thin). `done` is in scope here; it isn't in the outer catch.
      if (err instanceof BudgetExhausted && !dryRun) {
        await recordCompleted(engine, cpKey, [...done]);
      }
      throw err;
    }

    result.pages_failed = pool.errored;

    if (!dryRun) {
      await recordCompleted(engine, cpKey, [...done]);
      // Clear the checkpoint only on a clean, complete run so an immediate
      // re-run starts fresh (enriched pages drop out of the thin set anyway).
      if (!pool.aborted && !signal?.aborted) {
        await clearOpCheckpoint(engine, cpKey);
      }
    }
  };

  // One tracker reference for both the run and the post-hoc overage check.
  // External tracker (cycle phase): used as-is, no withBudgetTracker wrap (that
  // would REPLACE not stack). Internal: capped at maxCostUsd ?? DEFAULT.
  const tracker = opts.budgetTracker ?? new BudgetTracker({
    maxCostUsd: opts.maxCostUsd ?? DEFAULT_MAX_COST_USD,
    label: `enrich:${sourceId}`,
  });
  try {
    if (opts.budgetTracker) {
      await body();
    } else {
      await withBudgetTracker(tracker, body);
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      result.budget_exhausted = true;
      return result; // partial run; caller surfaces it (NOT a thrown failure)
    }
    throw err;
  } finally {
    result.spent_usd = tracker.totalSpent;
  }

  // P1#3 (codex): gateway.chat swallows a BudgetExhausted thrown by the FINAL
  // call's tracker.record() ("surfaced via next reserve") — but there is no next
  // reserve, so body() returns normally with budget_exhausted unset despite the
  // overage. Detect it post-hoc so the result is honest. Enrich-local: reads the
  // tracker's read-only cap; no shared gateway.ts change.
  if (tracker.cap !== undefined && tracker.totalSpent > tracker.cap) {
    result.budget_exhausted = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI parsing + handler.
// ---------------------------------------------------------------------------

interface ParsedArgs {
  sourceId?: string;
  types?: PageType[];
  order?: EnrichOrder;
  limit?: number;
  workers?: number;
  model?: string;
  maxCostUsd?: number;
  minContextChars?: number;
  thinThreshold?: number;
  reenrichAfterMs?: number;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  json?: boolean;
  help?: boolean;
  error?: string;
}

function parseDurationDays(raw: string): number | undefined {
  // Accept "30", "30d", "12h". Returns ms.
  const m = raw.match(/^(\d+)\s*(d|h)?$/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = m[2] ?? 'd';
  return unit === 'h' ? n * 3_600_000 : n * 86_400_000;
}

export function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    // --background / --follow are handled by the dispatcher (maybeBackground /
    // fan-out); accept them here as no-ops so the inline-degrade path (PGLite)
    // and buildJobParams don't trip the unknown-flag guard.
    if (a === '--background' || a === '--follow') { continue; }
    if (a === '--thin') { continue; } // accepted; thin-filter is always applied
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--force' || a === '--resume') {
      // --resume is the documented flag; it's the DEFAULT behavior (checkpoint
      // auto-resumes). --force clears the checkpoint. Treat --resume as a no-op
      // affirmation and --force as the clear.
      if (a === '--force') out.force = true;
      continue;
    }
    if (a === '--yes' || a === '-y') { out.yes = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--source' || a === '--source-id') { out.sourceId = args[++i]; continue; }
    if (a === '--model') { out.model = args[++i]; continue; }
    if (a === '--order') {
      const v = args[++i] as EnrichOrder;
      if (!ENRICH_ORDERS.includes(v)) {
        out.error = `Invalid --order: ${v}. Allowed: ${ENRICH_ORDERS.join(', ')}`;
        return out;
      }
      out.order = v;
      continue;
    }
    if (a === '--types') {
      const v = args[++i] ?? '';
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) { out.error = '--types requires a comma-separated list'; return out; }
      out.types = parts as PageType[];
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) out.limit = n;
      continue;
    }
    if (a === '--workers' || a === '--concurrency') {
      try { out.workers = parseWorkers(args[++i]); }
      catch (e) { out.error = (e as Error).message; return out; }
      continue;
    }
    if (a === '--max-usd' || a === '--max-cost-usd') {
      const n = parseFloat(args[++i] ?? '');
      if (Number.isFinite(n) && n > 0) out.maxCostUsd = n;
      continue;
    }
    if (a === '--min-context') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n >= 0) out.minContextChars = n;
      continue;
    }
    if (a === '--thin-threshold') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) out.thinThreshold = n;
      continue;
    }
    if (a === '--reenrich-after') {
      const ms = parseDurationDays(args[++i] ?? '');
      if (ms === undefined) { out.error = 'Invalid --reenrich-after (use e.g. 30d or 12h)'; return out; }
      out.reenrichAfterMs = ms;
      continue;
    }
    if (a.startsWith('--')) { out.error = `Unknown flag: ${a}`; return out; }
  }
  return out;
}

const HELP = `Usage: gbrain enrich [options]

Develop thin (stub) pages into real, cited pages by consolidating what the
brain ALREADY knows about each entity — scattered mentions, inbound-link
context, facts, and the existing stub — via one grounded LLM call per page.
No web/external lookup (that stays the agent-driven 'enrich' skill); this is
brain-internal synthesis only.

Options:
  --thin                 Select stub pages (always applied; accepted for clarity).
  --order <signal>       Candidate ordering: inbound-links (default) | salience | updated.
  --types <list>         Comma-separated page types. Default: person,company.
  --limit <N>            Max pages this run. Default ${DEFAULT_LIMIT}.
  --workers <K>          Parallel page workers. Default 1. PGLite clamps to 1.
  --model <provider:id>  Chat model. Default: configured chat model.
                         For cheap bulk: --model anthropic:claude-haiku-4-5.
  --max-usd <FLOAT>      Cost cap (USD). Default ${DEFAULT_MAX_COST_USD}.
                         BEST-EFFORT under --workers > 1: can overshoot by up to
                         ~one in-flight call per worker. Pin --workers 1 for an
                         exact ceiling.
  --min-context <N>      Min retrieved-context chars to attempt synthesis.
                         Below it the page is skipped (insufficient context),
                         never fabricated. Default ${MIN_CONTEXT_CHARS}.
  --thin-threshold <N>   Body char length below which a page counts as thin.
                         Default ${DEFAULT_THIN_THRESHOLD}.
  --reenrich-after <dur> Skip pages enriched within this window (e.g. 30d, 12h).
                         Default ${DEFAULT_REENRICH_DAYS}d.
  --source <id>          Source to enrich. When omitted, all sources are
                         enumerated (CLI loops; --background fans out one job
                         per source).
  --dry-run              List candidates + cost estimate; no LLM, no write.
  --resume               Resume from the prior checkpoint (default behavior).
  --force                Clear the checkpoint and re-process every candidate.
  --background           Submit as Minion job(s); print job_id(s); exit.
  --json                 Machine-readable summary.
  --yes, -y              Auto-confirm cost preview in non-TTY contexts.
  --help, -h             Show this help.

Provenance: enriched pages get frontmatter enriched_at + enriched_by=${ENRICHED_BY}
(survives put_page write-through). The recency guard reads enriched_at.
`;

function buildJobParams(args: string[]): Record<string, unknown> {
  const p = parseArgs(args);
  return {
    sourceId: p.sourceId,
    types: p.types,
    order: p.order,
    limit: p.limit,
    workers: p.workers,
    model: p.model,
    maxCostUsd: p.maxCostUsd,
    minContextChars: p.minContextChars,
    thinThreshold: p.thinThreshold,
    reenrichAfterMs: p.reenrichAfterMs,
    dryRun: p.dryRun,
    force: p.force,
  };
}

/**
 * P1#4 (codex): the multi-source `--background` fan-out must key each per-source
 * Minion job on the FULL run config, not just the source id. `MinionQueue.add()`
 * returns any existing row for a key (including completed ones, since
 * remove_on_complete defaults false), so a bare `enrich:${sid}` key silently
 * returned the OLD job when the user re-ran with a different --model / --limit /
 * --force / --dry-run. Content-hashing the full job params (the same scheme the
 * single-source `maybeBackground` path uses) means a different intent enqueues
 * new work. `fingerprint()` is canonical-JSON + hash, so key order is stable.
 */
export function backgroundIdempotencyKey(sourceId: string, args: string[]): string {
  return `enrich:${sourceId}:${fingerprint({ ...buildJobParams(args), sourceId })}`;
}

function emptyAgg(): EnrichResult {
  return {
    candidates_considered: 0,
    pages_enriched: 0,
    pages_skipped_insufficient: 0,
    pages_skipped_lock: 0,
    pages_skipped_disappeared: 0,
    pages_failed: 0,
    would_enrich: 0,
  };
}

function addInto(agg: EnrichResult, r: EnrichResult): void {
  agg.candidates_considered += r.candidates_considered;
  agg.pages_enriched += r.pages_enriched;
  agg.pages_skipped_insufficient += r.pages_skipped_insufficient;
  agg.pages_skipped_lock += r.pages_skipped_lock;
  agg.pages_skipped_disappeared += r.pages_skipped_disappeared;
  agg.pages_failed += r.pages_failed;
  agg.would_enrich = (agg.would_enrich ?? 0) + (r.would_enrich ?? 0);
}

export async function runEnrich(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  // --background: fan out one Minion job per source (D4). With --source, one job.
  // PGLite has no worker daemon → fall through to inline (note emitted below).
  if (args.includes('--background') && engine.kind !== 'pglite') {
    const parsed = parseArgs(args);
    if (parsed.error) { console.error(parsed.error); process.exit(1); }
    const sourceIds = parsed.sourceId
      ? [parsed.sourceId]
      : (await listSources(engine)).map((s) => s.id);
    if (sourceIds.length <= 1) {
      // Single source (or only one source exists) → one job via maybeBackground.
      const backgrounded = await maybeBackground({
        engine,
        args: parsed.sourceId ? args : [...args, '--source', sourceIds[0] ?? 'default'],
        jobName: 'enrich',
        paramBuilder: buildJobParams,
      });
      if (backgrounded) return;
    } else {
      // Multi-source fan-out: one job per source.
      const { MinionQueue } = await import('../core/minions/queue.ts');
      const queue = new MinionQueue(engine);
      const ids: number[] = [];
      for (const sid of sourceIds) {
        const job = await queue.add(
          'enrich',
          { ...buildJobParams(args), sourceId: sid },
          { idempotency_key: backgroundIdempotencyKey(sid, args) },
        );
        ids.push(job.id);
      }
      console.log(`Submitted ${ids.length} enrich job(s) (one per source): ${ids.map((i) => `job_id=${i}`).join(' ')}`);
      console.log('Follow with: gbrain jobs follow <id>');
      return;
    }
  } else if (args.includes('--background')) {
    // PGLite + --background: no worker daemon; degrade to inline.
    process.stderr.write('[--background] PGLite has no worker daemon; running enrich inline.\n');
  }

  const parsed = parseArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    console.error(HELP);
    process.exit(1);
  }

  // Chat gateway required for non-dry-run.
  if (!parsed.dryRun && !isAvailable('chat')) {
    console.error('Chat gateway unavailable. Configure a chat model (e.g. `gbrain config set chat_model anthropic:claude-haiku-4-5`), or pass --dry-run to preview candidates.');
    process.exit(1);
  }

  // Non-TTY execute without --max-usd or --yes is refused (cost guardrail).
  if (!parsed.dryRun && parsed.maxCostUsd === undefined && !parsed.yes && !process.stdout.isTTY) {
    console.error('Refusing to spend without a cap in a non-interactive context. Pass --max-usd <FLOAT> or --yes.');
    process.exit(1);
  }

  const sourceIds: string[] = parsed.sourceId
    ? [parsed.sourceId]
    : (await listSources(engine)).map((s) => s.id);

  // Dry-run cost preview (TTY) before spending.
  if (!parsed.dryRun && process.stdout.isTTY && !parsed.yes && parsed.maxCostUsd === undefined) {
    const limit = parsed.limit ?? DEFAULT_LIMIT;
    const est = (limit * sourceIds.length * COST_ESTIMATE_PER_PAGE_USD).toFixed(2);
    console.error(`About to enrich up to ${limit} page(s) per source across ${sourceIds.length} source(s), est. ~$${est}. Re-run with --max-usd or --yes to confirm.`);
    process.exit(2);
  }

  const aggregate = emptyAgg();
  let totalSpent = 0;
  let anyBudgetExhausted = false;
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('enrich', sourceIds.length);

  try {
    for (const sourceId of sourceIds) {
      const r = await runEnrichCore(engine, {
        sourceId,
        types: parsed.types,
        order: parsed.order,
        limit: parsed.limit,
        workers: parsed.workers,
        model: parsed.model,
        maxCostUsd: parsed.maxCostUsd,
        minContextChars: parsed.minContextChars,
        thinThreshold: parsed.thinThreshold,
        reenrichAfterMs: parsed.reenrichAfterMs,
        dryRun: parsed.dryRun,
        force: parsed.force,
      });
      addInto(aggregate, r);
      if (r.spent_usd) totalSpent += r.spent_usd;
      if (r.budget_exhausted) anyBudgetExhausted = true;
      progress.tick(1, `${sourceId}: ${r.pages_enriched} enriched`);
    }
  } finally {
    progress.finish();
  }

  if (parsed.json) {
    console.log(JSON.stringify({
      schema_version: 1,
      ...aggregate,
      spent_usd: totalSpent,
      budget_exhausted: anyBudgetExhausted,
      sources: sourceIds.length,
      dry_run: !!parsed.dryRun,
    }, null, 2));
  } else if (parsed.dryRun) {
    console.log(
      `\n(dry run) ${aggregate.candidates_considered} thin candidate(s) across ${sourceIds.length} source(s); ` +
      `${aggregate.would_enrich ?? 0} have enough context to enrich, ` +
      `${aggregate.pages_skipped_insufficient} lack context. ` +
      `Est. ~$${(aggregate.candidates_considered * COST_ESTIMATE_PER_PAGE_USD).toFixed(2)} to run.`,
    );
  } else {
    console.log(
      `\nDone: enriched ${aggregate.pages_enriched} page(s) ` +
      `(${aggregate.pages_skipped_insufficient} skipped insufficient, ` +
      `${aggregate.pages_skipped_lock} lock-busy, ${aggregate.pages_failed} failed) ` +
      `across ${sourceIds.length} source(s). Spent ~$${totalSpent.toFixed(4)}.`,
    );
    if (anyBudgetExhausted) {
      console.log('  Budget cap reached. Re-run with a higher --max-usd to continue.');
    }
  }

  if (aggregate.pages_failed > 0 && aggregate.pages_enriched === 0 && !parsed.dryRun) {
    process.exit(1);
  }
}
