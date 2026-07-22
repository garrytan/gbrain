/**
 * v0.41.13.0 T18 retrofit note: this is a Minion HANDLER, not a CLI
 * batch loop. The progressive-batch primitive's stage model (trial →
 * ramp → full) doesn't fit Minion handler semantics (one job per page,
 * worker-driven). The primitive's audit + cost-cap value lives at the
 * SUBMITTER side (`gbrain reindex --markdown`, which IS retrofitted in
 * T11), not at the handler. The handler already routes its cost through
 * the global Haiku rate-leaser (D26 P0-3). No further retrofit needed.
 *
 * v0.40.3.0 — Minion handler for per-page contextual retrieval re-embed.
 *
 * One job per page (D10). Submitted by:
 *   - The mode-switch hook in src/commands/config.ts when the user
 *     accepts the upgrade cost prompt.
 *   - `doctor --remediate` when contextual_retrieval_coverage flags drift.
 *   - The reindex command for backfill orchestration.
 *
 * This handler is DELIBERATELY thin (D23) — it wires the global Haiku
 * rate-leaser (D26 P0-3), validates the job payload, and delegates the
 * actual re-embed work to `src/core/contextual-retrieval-service.ts:
 * reembedPageWithContextualRetrieval`. The service owns the two-phase
 * build pattern + page-level fall-back per D14. This handler owns:
 *   - Rate-lease acquire/release per Haiku call (shared key across the
 *     whole worker pool so concurrent page jobs don't blow the 50 RPM
 *     default per D26 P0-3).
 *   - Source-id derivation from page-id (D27 P2-1 defense-in-depth
 *     against stale/malicious payloads that try to apply source-level
 *     trust decisions from the wrong source).
 *   - Result classification into Minion success/throw semantics so the
 *     queue retries transient failures and dead-letters permanents.
 *
 * Protected name registration (D20-T8): `contextual_reindex_per_chunk`
 * is in `src/core/minions/protected-names.ts:PROTECTED_JOB_NAMES`.
 * MCP / OAuth-scoped callers cannot submit this job; only trusted
 * local callers (CLI, autopilot, doctor --remediate) can.
 */

import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import {
  reembedPageWithContextualRetrieval,
  type ReembedPageResult,
} from '../../contextual-retrieval-service.ts';
import {
  acquireLease,
  releaseLease,
} from '../rate-leases.ts';
import { resolveSearchMode, loadSearchModeConfig } from '../../search/mode.ts';

const RATE_LEASE_KEY = 'anthropic:utility:contextual-synopsis';

/**
 * Default global Haiku RPM for contextual synopsis calls. Anthropic's
 * published default is 50 RPM for Haiku 4.5; operators can raise via
 * the env override on a tier with higher quota.
 */
const DEFAULT_HAIKU_RPM = 50;

function resolveMaxConcurrent(): number {
  const env = process.env.GBRAIN_CONTEXTUAL_HAIKU_RPM;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_HAIKU_RPM;
}

/**
 * Job payload shape. Per D27 P2-1, only the `page_id` is authoritative;
 * the handler loads the page row and DERIVES source_id from it. Any
 * `source_id` field in the payload that mismatches the loaded value
 * triggers UnrecoverableError (stale/malicious payload defense).
 *
 * `expected_source_id` is optional — when present, the handler verifies
 * it matches the loaded page's source_id. Lets the submitter (mode-switch
 * hook with known per-source plans) catch its own staleness.
 */
export interface ContextualReindexJobData {
  page_slug: string;
  expected_source_id?: string;
}

export interface MakeContextualReindexHandlerOpts {
  engine: BrainEngine;
}

/**
 * Build the Minion handler closure. The worker registers this via
 * `worker.register('contextual_reindex_per_chunk', handler)`.
 */
export function makeContextualReindexHandler(opts: MakeContextualReindexHandlerOpts) {
  const { engine } = opts;

  return async function contextualReindexHandler(
    ctx: MinionJobContext,
  ): Promise<{ ok: true; mode_applied: string; chunks_embedded: number }> {
    const data = parseJobData(ctx.data);

    // Load page row to derive the authoritative source_id (D27 P2-1).
    // Without sourceId we can't do a lookup at all — fall back to
    // 'default' for the initial lookup, then if the page isn't found
    // there, surface as unrecoverable (the submitter should have
    // included expected_source_id).
    let foundPage = await tryLoadPageAcrossSources(engine, data.page_slug);
    if (!foundPage) {
      throw new UnrecoverableError(
        `Page not found for slug '${data.page_slug}'. ` +
          `Submitter should include expected_source_id or the page may have been deleted.`,
      );
    }

    // D27 P2-1: reject mismatched expected_source_id (stale payload).
    if (data.expected_source_id && data.expected_source_id !== foundPage.source_id) {
      throw new UnrecoverableError(
        `Source id mismatch for page '${data.page_slug}': expected ` +
          `'${data.expected_source_id}', page actually lives in ` +
          `'${foundPage.source_id}'. Stale payload?`,
      );
    }

    // Load the resolved CR mode + kill switch via the canonical search
    // config path. loadSearchModeConfig returns {mode, overrides} from the
    // engine's config table; resolveSearchMode walks the per-call >
    // per-key > mode bundle precedence chain.
    const searchInput = await loadSearchModeConfig(engine);
    const knobs = resolveSearchMode(searchInput);
    const globalMode = knobs.contextual_retrieval;
    const killSwitchDisabled = knobs.contextual_retrieval_disabled;

    // Run the service with rate-leasing hooks (D26 P0-3). Each Haiku
    // call inside the service acquires/releases a lease against the
    // shared key across all worker processes.
    const maxConcurrent = resolveMaxConcurrent();
    let currentLeaseId: number | null = null;

    const result: ReembedPageResult = await reembedPageWithContextualRetrieval({
      engine,
      pageSlug: data.page_slug,
      sourceId: foundPage.source_id,
      globalMode,
      killSwitchDisabled,
      abortSignal: ctx.signal,
      acquireSynopsisLease: async () => {
        // Poll-acquire with brief backoff. The service's per-chunk loop
        // is sequential within a page; this guards against the cross-
        // worker pile-up.
        let attempts = 0;
        const maxAttempts = 60; // ~1 min max wait per chunk before giving up
        while (attempts < maxAttempts) {
          const res = await acquireLease(engine, RATE_LEASE_KEY, ctx.id, maxConcurrent, {
            ttlMs: 60_000,
          });
          if (res.acquired && res.leaseId != null) {
            currentLeaseId = res.leaseId;
            return;
          }
          attempts++;
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error(
          `Failed to acquire ${RATE_LEASE_KEY} lease after ${maxAttempts} attempts; ` +
            `Haiku rate limit pile-up too deep.`,
        );
      },
      releaseSynopsisLease: async () => {
        if (currentLeaseId != null) {
          await releaseLease(engine, currentLeaseId);
          currentLeaseId = null;
        }
      },
    });

    return classifyResult(data.page_slug, result);
  };
}

function parseJobData(raw: Record<string, unknown> | undefined): ContextualReindexJobData {
  if (!raw || typeof raw !== 'object') {
    throw new UnrecoverableError(
      'contextual_reindex_per_chunk job has empty data — page_slug required.',
    );
  }
  const pageSlug = raw.page_slug;
  if (typeof pageSlug !== 'string' || pageSlug.length === 0) {
    throw new UnrecoverableError(
      'contextual_reindex_per_chunk requires data.page_slug: string.',
    );
  }
  const expectedSourceId =
    typeof raw.expected_source_id === 'string' ? raw.expected_source_id : undefined;
  return { page_slug: pageSlug, expected_source_id: expectedSourceId };
}

/**
 * Try loading the page in every source the engine knows about. Stops at
 * first match. Most brains are single-source; federated brains may have
 * the same slug in multiple sources but the page_id (and indirectly
 * source_id) is the authoritative tiebreaker per D27 P2-1.
 */
async function tryLoadPageAcrossSources(
  engine: BrainEngine,
  pageSlug: string,
): Promise<{ source_id: string } | null> {
  // First try default. Most brains live here.
  const defaultPage = await engine.getPage(pageSlug, { sourceId: 'default' });
  if (defaultPage) return { source_id: defaultPage.source_id };

  // Fall back to walking sources.
  const sources = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE archived = false`,
  );
  for (const { id } of sources) {
    if (id === 'default') continue; // already tried
    const p = await engine.getPage(pageSlug, { sourceId: id });
    if (p) return { source_id: p.source_id };
  }
  return null;
}

function classifyResult(
  pageSlug: string,
  result: ReembedPageResult,
): { ok: true; mode_applied: string; chunks_embedded: number } {
  switch (result.kind) {
    case 'success':
      return {
        ok: true,
        mode_applied: result.mode_applied,
        chunks_embedded: result.chunks_embedded,
      };
    case 'page_fallback':
      // Page-level fall-back is still a successful outcome from Minion's
      // perspective — chunks are embedded, page is stamped at the lower
      // tier. The audit JSONL captured the original failure.
      return {
        ok: true,
        mode_applied: result.mode_applied,
        chunks_embedded: result.chunks_embedded,
      };
    case 'skipped':
      return { ok: true, mode_applied: 'skipped', chunks_embedded: 0 };
    case 'transient_error':
      // Throw so Minion retries. The queue's backoff policy handles
      // rate-limit + network blips.
      throw new Error(
        `[contextual_reindex] transient error on page '${pageSlug}' (${result.cause}): ${result.detail}`,
      );
    case 'permanent_error':
      // UnrecoverableError sends straight to dead-letter; doctor surfaces.
      throw new UnrecoverableError(
        `[contextual_reindex] permanent error on page '${pageSlug}' (${result.cause}): ${result.detail}`,
      );
  }
}
