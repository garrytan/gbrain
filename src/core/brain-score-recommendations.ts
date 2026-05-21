import { createHash } from 'crypto';
import type { BrainHealth } from './types.ts';
import { ANTHROPIC_PRICING } from './anthropic-pricing.ts';
import { lookupEmbeddingPrice, estimateCostFromChars } from './embedding-pricing.ts';

/** Minimal Check shape consumed by classifyChecks. Subset of doctor.ts's
 *  Check; we intentionally don't import from doctor.ts (would create a
 *  cycle: doctor → recommendations → doctor). */
export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
}

/**
 * Shared recommendation generator for brain-health remediation.
 *
 * Consumed by both:
 *   - `gbrain doctor --remediation-plan` / `--remediate` (queue-based execution)
 *   - `gbrain features --auto-fix` (inline execution preserved per D15)
 *
 * Pure module — no engine I/O. Input is `BrainHealth` (already produced by
 * engine.getHealth()) + a `RecommendationContext` that names which prereqs
 * are met (API keys, repo path, source id).
 *
 * Three-state classification per check (D13):
 *   - `remediable`: a job exists AND prereqs are met. Emit it.
 *   - `human_only`:  no autofix (orphans archive, multi_source_drift,
 *                    eval_drift). Surface as informational; don't queue.
 *   - `blocked`:     autofix exists, prereq missing (e.g. missing API key
 *                    for embed). Surface with the missing prereq; don't queue.
 *
 * `maxReachableScore(health, classifications)` computes the score ceiling
 * assuming only `remediable` checks fire. Callers refuse `--target-score >
 * ceiling` so empty / API-key-missing brains don't spin forever.
 *
 * Plan: D13 + D14 + folded scope item A (cost-budget gate) from outside-voice
 * review. See ~/.claude/plans/system-instruction-you-are-working-fluttering-ocean.md.
 */

/**
 * Severity buckets — drive ordering (critical first) and operator UX
 * (in the human-readable plan output, critical items get a louder prefix).
 */
export type RemediationSeverity = 'critical' | 'high' | 'medium' | 'low';

/** Status of an individual check's autofix path. */
export type RemediationStatus = 'remediable' | 'human_only' | 'blocked';

export interface Remediation {
  /** Stable id (e.g. 'sync.repo', 'embed.stale', 'embed.code'). Survives
   *  check renames; referenced by `depends_on`. */
  id: string;
  /** Minion handler name (must match a registered handler). */
  job: string;
  /** Params passed to the handler. */
  params: Record<string, unknown>;
  /** Content-hash idempotency key: `<source>:<job>:sha8(canonical-JSON(params))`.
   *  Per D9: NO time-slot. Retry suffix `:r<N>` appended by --remediate when
   *  prior key's job is in `failed`/`dead` state. */
  idempotency_key: string;
  severity: RemediationSeverity;
  /** Upper-bound runtime estimate for ordering + --target-score budgeting. */
  est_seconds: number;
  /** USD cost estimate when applicable (embed by chunk count × $/MTok;
   *  synthesize / patterns / consolidate by est Sonnet calls × $/MTok).
   *  Sum across plan steps is the gate for --max-usd. */
  est_usd_cost?: number;
  /** Other Remediation.id values that MUST complete first. References ids,
   *  NOT check names (D14 — closes codex #22 fan-out ambiguity). */
  depends_on?: string[];
  /** One-line "what this fixes" for human output. */
  rationale: string;
  /** True if `job` is in PROTECTED_JOB_NAMES (D11). Mirrors trust-gate state
   *  so callers don't have to re-derive it. */
  protected?: boolean;
  /** Always 'remediable' when this struct is in the plan. The doctor surface
   *  also produces blocked-entries (with `blocked_reason`) but those don't
   *  enter the executable plan. */
  status: RemediationStatus;
  /** Populated when status === 'blocked'. E.g. 'missing OPENAI_API_KEY'. */
  blocked_reason?: string;
}

export interface RecommendationContext {
  /** Source id this remediation is scoped to (multi-source brains). */
  sourceId?: string;
  /** Brain repo path on disk (for sync). */
  repoPath?: string;
  /** Configured embedding model id (e.g. 'openai:text-embedding-3-large'). */
  embeddingModel?: string;
  /** Configured embedding dimension (3072 / 1536 / 1024 / etc.). */
  embeddingDimensions?: number;
  /** Whether the embedding provider has a usable API key. */
  hasEmbeddingApiKey?: boolean;
  /** Configured chat / synthesis model id. */
  chatModel?: string;
  /** Whether the chat provider has a usable API key. */
  hasChatApiKey?: boolean;
}

/** Triage result for one check. */
export interface CheckClassification {
  check: string;
  status: RemediationStatus;
  /** When status !== 'remediable', what's missing. */
  reason?: string;
}

/**
 * Generate ordered Remediation list from health snapshot + context.
 *
 * Sort: severity (critical > high > medium > low), then est_seconds asc.
 * Topological order over `depends_on` is the caller's job — they walk this
 * list and respect dependencies. Recommendation generator just picks order
 * within a strata.
 *
 * Returns ONLY `remediable` items. `blocked` items surface via
 * `classifyChecks()` and are rendered alongside the plan as informational.
 */
export function computeRecommendations(
  health: BrainHealth,
  ctx: RecommendationContext,
): Remediation[] {
  const out: Remediation[] = [];
  const source = ctx.sourceId ?? 'default';

  // ---------------------------------------------------------------------
  // sync.repo — fires when sync hasn't run recently OR pages are stale
  // ---------------------------------------------------------------------
  if (ctx.repoPath && health.stale_pages > 0) {
    const params = { repoPath: ctx.repoPath, sourceId: ctx.sourceId, noEmbed: true };
    out.push({
      id: 'sync.repo',
      job: 'sync',
      params,
      idempotency_key: idemKey(source, 'sync', params),
      severity: health.stale_pages > 50 ? 'high' : 'medium',
      est_seconds: Math.min(600, 30 + health.stale_pages * 0.5),
      est_usd_cost: 0,  // sync is fs+DB only
      depends_on: [],
      rationale: `${health.stale_pages} stale page${health.stale_pages === 1 ? '' : 's'} on disk`,
      status: 'remediable',
    });
  }

  // ---------------------------------------------------------------------
  // embed.stale — missing embeddings. Critical: invisible to vector search
  // ---------------------------------------------------------------------
  if (health.missing_embeddings > 0 && ctx.hasEmbeddingApiKey !== false) {
    const params = { stale: true, sourceId: ctx.sourceId };
    const embedModel = ctx.embeddingModel ?? 'openai:text-embedding-3-large';
    const embedDims = ctx.embeddingDimensions ?? 3072;
    // Rough char estimate per chunk ~ 1.5k chars (chunker target).
    const estChars = health.missing_embeddings * 1500;
    let est_usd_cost = 0;
    try {
      const priceLookup = lookupEmbeddingPrice(embedModel);
      if (priceLookup.kind === 'known') {
        est_usd_cost = estimateCostFromChars(estChars, priceLookup.pricePerMTok);
      }
    } catch {
      /* unknown model — leave at 0, surface as warning elsewhere */
    }
    out.push({
      id: 'embed.stale',
      job: 'embed',
      params,
      idempotency_key: idemKey(source, 'embed', { ...params, embedModel, embedDims }),
      severity: 'critical',
      est_seconds: Math.min(3600, 5 + health.missing_embeddings * 0.05),
      est_usd_cost,
      // sync should run first so embed sees fresh pages.
      depends_on: ctx.repoPath && health.stale_pages > 0 ? ['sync.repo'] : [],
      rationale: `${health.missing_embeddings} chunk${health.missing_embeddings === 1 ? '' : 's'} invisible to vector search`,
      status: 'remediable',
    });
  }

  // ---------------------------------------------------------------------
  // backlinks.fix — dead links (refs to non-existent slugs)
  // ---------------------------------------------------------------------
  if (health.dead_links > 0 && ctx.repoPath) {
    const params = { action: 'fix', dir: ctx.repoPath };
    out.push({
      id: 'backlinks.fix',
      job: 'backlinks',
      params,
      idempotency_key: idemKey(source, 'backlinks', params),
      severity: 'high',
      est_seconds: Math.min(300, 10 + health.dead_links * 0.5),
      est_usd_cost: 0,
      depends_on: [],
      rationale: `${health.dead_links} dead link${health.dead_links === 1 ? '' : 's'}`,
      status: 'remediable',
    });
  }

  // ---------------------------------------------------------------------
  // extract.all — runs after sync to materialize links + timeline.
  // Triggered when sync.repo fires (because sync was set to noEmbed:true,
  // and noExtract:true after T5 lands → extract job is the materializer).
  // ---------------------------------------------------------------------
  if (ctx.repoPath && health.stale_pages > 0) {
    const params = { mode: 'all', dir: ctx.repoPath };
    out.push({
      id: 'extract.all',
      job: 'extract',
      params,
      idempotency_key: idemKey(source, 'extract', params),
      severity: 'medium',
      est_seconds: Math.min(600, 30 + health.page_count * 0.01),
      est_usd_cost: 0,
      depends_on: ['sync.repo'],
      rationale: 'Materialize link + timeline edges from fresh pages',
      status: 'remediable',
    });
  }

  // Sort: severity (critical first), then est_seconds ascending so quick
  // wins come first within a severity tier.
  const sevRank: Record<RemediationSeverity, number> = {
    critical: 0, high: 1, medium: 2, low: 3,
  };
  out.sort((a, b) => {
    const sd = sevRank[a.severity] - sevRank[b.severity];
    if (sd !== 0) return sd;
    return a.est_seconds - b.est_seconds;
  });

  return out;
}

/**
 * Triage every check from the doctor report into one of three buckets.
 * Used by the doctor remediation surface to surface what's not auto-fixable
 * (or auto-fixable-but-prereq-missing) as informational alongside the plan.
 *
 * Checks not listed here default to `human_only` (conservative — anything
 * the recommendation generator doesn't know about is treated as needing
 * operator judgment, not autonomous remediation).
 */
export function classifyChecks(
  checks: Check[],
  ctx: RecommendationContext,
): CheckClassification[] {
  return checks.map((c) => classifyOne(c, ctx));
}

function classifyOne(check: Check, ctx: RecommendationContext): CheckClassification {
  // Map check names to their remediation status. The recommendation
  // generator above handles `remediable`; this maps the rest.
  switch (check.name) {
    // --- remediable paths (matched by recommendation generator) ---
    case 'brain_score':
    case 'sync_freshness':
      if (!ctx.repoPath) {
        return { check: check.name, status: 'blocked', reason: 'no repo configured (set sync.repo_path)' };
      }
      return { check: check.name, status: 'remediable' };
    case 'missing_embeddings':
      if (ctx.hasEmbeddingApiKey === false) {
        return { check: check.name, status: 'blocked', reason: 'missing embedding API key' };
      }
      return { check: check.name, status: 'remediable' };
    case 'dead_links':
      if (!ctx.repoPath) {
        return { check: check.name, status: 'blocked', reason: 'no repo configured' };
      }
      return { check: check.name, status: 'remediable' };

    // --- human_only paths ---
    case 'orphan_pages':        // archive is product judgment, not maintenance
    case 'multi_source_drift':
    case 'eval_drift':
    case 'slug_fallback_audit':
    case 'whoknows_health':
    case 'rls_event_trigger':   // operator must intervene
    case 'reranker_health':
      return { check: check.name, status: 'human_only', reason: 'no autonomous remediation' };

    default:
      // Unknown checks: conservative default. Surfaces as informational
      // rather than blocking the loop.
      return { check: check.name, status: 'human_only', reason: 'unmapped check' };
  }
}

/**
 * Compute the score ceiling assuming only `remediable` checks fire.
 *
 * Each component of brain_score (embed_coverage 35, link_density 25,
 * timeline_coverage 15, no_orphans 15, no_dead_links 10) maps to a
 * remediable or non-remediable classification. Components without an
 * autofix path stay at their current score; remediable components can
 * theoretically reach their max.
 *
 * Returns the ceiling; --remediate refuses --target-score > ceiling
 * with a clear "this brain can only reach X without manual intervention"
 * error.
 */
export function maxReachableScore(
  health: BrainHealth,
  classifications: CheckClassification[],
): number {
  const classMap = new Map(classifications.map((c) => [c.check, c.status]));

  // Component → max contribution + remediability
  // Conservative: if the mapped check is NOT remediable, the component
  // stays at its current value (can't be lifted by autonomous action).
  let ceiling = 0;
  ceiling += pickMax(health.embed_coverage_score, 35, classMap.get('missing_embeddings'));
  ceiling += pickMax(health.link_density_score, 25, classMap.get('dead_links'));
  ceiling += pickMax(health.timeline_coverage_score, 15, undefined);  // no current autofix
  ceiling += pickMax(health.no_orphans_score, 15, classMap.get('orphan_pages'));
  ceiling += pickMax(health.no_dead_links_score, 10, classMap.get('dead_links'));
  return Math.min(100, Math.round(ceiling));
}

function pickMax(current: number, max: number, status: RemediationStatus | undefined): number {
  if (status === 'remediable') return max;
  return current;
}

// ---------------------------------------------------------------------
// Idempotency key construction (D9 — content-hash, no time-slot).
// Same params produce the same key across runs. Failed-row replay
// appends `:r<N>` (caller responsibility — handled by --remediate loop).
// ---------------------------------------------------------------------

function idemKey(source: string, job: string, params: Record<string, unknown>): string {
  return `${source}:${job}:${sha8(canonicalJson(params))}`;
}

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * Returns the per-recommendation USD cost ceiling for an Anthropic-model
 * job. Used by synthesize/patterns/consolidate cost estimates.
 *
 * `estCallsPerInvocation` is a per-job heuristic (e.g. synthesize ~
 * 20 calls per invocation; patterns ~ 5). Multiplied by per-call token
 * budget × Anthropic-model price.
 */
export function estimateAnthropicCost(
  modelId: string,
  estCallsPerInvocation: number,
  estInputTokensPerCall = 5_000,
  estOutputTokensPerCall = 1_000,
): number {
  const pricing = ANTHROPIC_PRICING[modelId];
  if (!pricing) return 0;
  const inputCost = (estInputTokensPerCall * estCallsPerInvocation / 1_000_000) * pricing.input;
  const outputCost = (estOutputTokensPerCall * estCallsPerInvocation / 1_000_000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(2));
}
