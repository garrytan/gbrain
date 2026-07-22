import { createHash } from 'crypto';
import type { BrainHealth } from './types.ts';
import { canonicalLookup } from './model-pricing.ts';
import { lookupEmbeddingPrice, estimateCostFromChars } from './embedding-pricing.ts';
import { getRecipe } from './ai/recipes/index.ts';
import { parseModelId } from './ai/model-resolver.ts';

/**
 * v0.40.x: env-var name → file/DB config field, for hosted embedding providers
 * whose config-plane key is actually propagated to the AI gateway. Producers of
 * RecommendationContext (doctor + autopilot) use this to build a sync
 * `resolveKey` closure without re-parsing recipes.
 *
 * Only OPENAI_API_KEY and ZEROENTROPY_API_KEY appear here because those are the
 * only embedding keys `buildGatewayConfig` (src/cli.ts) folds from config into
 * the gateway env. VOYAGE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY are deliberately
 * absent: their config fields are NOT threaded to the gateway today, so the
 * producer closures fall through to checking `process.env` ONLY for them. That
 * matches what the gateway can actually use (the recipes read those keys from
 * env). Counting a config-plane voyage_api_key/google_api_key here would be a
 * false positive: doctor/autopilot would call the provider "configured" and
 * dispatch an embed.stale job that then fails auth at the gateway. When a future
 * change threads voyage_api_key/google_api_key into buildGatewayConfig (the open
 * voyage-config-mapping work), re-add the matching entry here in the same change.
 */
export const HOSTED_EMBED_KEY_CONFIG: Record<string, string> = {
  OPENAI_API_KEY: 'openai_api_key',
  ZEROENTROPY_API_KEY: 'zeroentropy_api_key',
};

/**
 * v0.40.x: is the configured embedding provider usable for the remediation
 * planner? Recipe-aware:
 *   - empty `auth_env.required` (ollama, llama-server, ...) ⇒ local, no hosted
 *     key needed ⇒ true.
 *   - hosted (openai, zeroentropyai, voyage, google, ...) ⇒ true iff every
 *     required key resolves.
 *
 * `resolveKey(envVar)` is supplied by the caller so each producer reads config
 * from its own source (doctor → file plane; autopilot → engine.getConfig).
 * Only the recipe logic is shared, not the config lookup.
 *
 * NOTE: deliberately NOT the same as `gateway.isAvailable('embedding')`.
 * isAvailable returns false for user_provided_models recipes (llama-server,
 * models: []) because it can't validate the model id. For a remediation
 * verdict we WANT true there — local embeddings work. Do not "align" them.
 * Uses the recipe registry (pure data), not the gateway runtime, so this
 * module stays free of AI-SDK coupling and works before engine.connect().
 */
export function embeddingProviderConfigured(
  embeddingModel: string | undefined,
  resolveKey: (envVar: string) => boolean,
): boolean {
  if (!embeddingModel) return false;
  let providerId: string;
  try {
    ({ providerId } = parseModelId(embeddingModel));
  } catch {
    return false; // malformed model id — mirror gateway.isAvailable's catch
  }
  const recipe = getRecipe(providerId);
  if (!recipe?.touchpoints?.embedding) return false;
  const required = recipe.auth_env?.required ?? [];
  return required.length === 0 ? true : required.every(resolveKey);
}

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
 * v0.40.3.0: RemediationStep + RemediationSeverity + RemediationStatus
 * lifted to src/core/remediation-step.ts so other doctor checks (lint,
 * integrity, sync_failures) can emit RemediationStep without circular
 * importing brain-score code. Re-exported here for back-compat AND to
 * avoid forcing every importer to update the path in one PR.
 *
 * The `Remediation` name is deprecated as of v0.40.3.0; use
 * `RemediationStep` going forward. Same shape; rename was for clarity.
 */
export {
  type RemediationStep,
  type RemediationStep as Remediation,
  type RemediationSeverity,
  type RemediationStatus,
  makeRemediationStep,
  idempotencyKey as makeRemediationIdempotencyKey,
  canonicalJson,
} from './remediation-step.ts';
import type {
  RemediationStep,
  RemediationStatus,
  RemediationSeverity,
} from './remediation-step.ts';
// Internal alias so the existing implementation below keeps compiling
// without a sed pass. New code should reference RemediationStep directly.
type Remediation = RemediationStep;

export interface RecommendationContext {
  /** Source id this remediation is scoped to (multi-source brains). */
  sourceId?: string;
  /** Brain repo path on disk (for sync). */
  repoPath?: string;
  /** Configured embedding model id (e.g. 'openai:text-embedding-3-large'). */
  embeddingModel?: string;
  /** Configured embedding dimension (3072 / 1536 / 1024 / etc.). */
  embeddingDimensions?: number;
  /**
   * Whether the configured embedding provider is usable. For hosted providers
   * this means the required API key resolves; for local providers (ollama,
   * llama-server — empty auth_env.required) it's true once configured, no key
   * needed. Compute via `embeddingProviderConfigured()`.
   */
  embeddingProviderConfigured?: boolean;
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
/**
 * Generalized (v0.41.18.0, A2 + codex finding #3): an optional third arg
 * lets callers inject RemediationStep entries discovered by doctor checks
 * outside this module's hardcoded planner. Without this, adding a
 * `Check.remediation` field to a new doctor check wouldn't auto-wire into
 * `gbrain doctor --remediation-plan` — the planner would just ignore it.
 *
 * Onboard's runRemediationPlan calls the 4 new check helpers (embed_staleness,
 * entity_link_coverage, timeline_coverage, takes_count) and threads their
 * RemediationStep[] outputs through this slot. Each helper produces its own
 * cheap query (D7 cheap-path preserved); aggregation happens in the caller.
 *
 * Sort + dedup applies across BOTH the hardcoded + extra entries: stable id
 * collisions resolve in favor of the hardcoded entry (legacy behavior wins),
 * which means extras only add coverage they're not duplicating.
 */
export function computeRecommendations(
  health: BrainHealth,
  ctx: RecommendationContext,
  extraRemediations: Remediation[] = [],
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
  if (health.missing_embeddings > 0 && ctx.embeddingProviderConfigured !== false) {
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

  // v0.41.18.0 (A2 + codex #3): merge caller-supplied extras. Hardcoded
  // entries win on id collision so legacy behavior is preserved when an
  // extra accidentally duplicates a hardcoded id.
  if (extraRemediations.length > 0) {
    const hardcodedIds = new Set(out.map((r) => r.id));
    for (const extra of extraRemediations) {
      if (!hardcodedIds.has(extra.id)) out.push(extra);
    }
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
      if (ctx.embeddingProviderConfigured === false) {
        return { check: check.name, status: 'blocked', reason: 'embedding provider not configured' };
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
  const pricing = canonicalLookup(modelId);
  if (!pricing) return 0;
  const inputCost = (estInputTokensPerCall * estCallsPerInvocation / 1_000_000) * pricing.input;
  const outputCost = (estOutputTokensPerCall * estCallsPerInvocation / 1_000_000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(2));
}
