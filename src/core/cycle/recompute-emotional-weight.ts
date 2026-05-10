/**
 * v0.29 — Recompute emotional weight phase. Runs AFTER extract + synthesize so
 * it sees the union of (sync-touched, synthesize-written) pages with fresh
 * tag + take state. Pure deterministic computation; no LLM calls.
 *
 * Two SQL round-trips total regardless of brain size (codex C4#3, C4#4):
 *   1. batchLoadEmotionalInputs — single CTE-shaped read with per-table
 *      pre-aggregates so a page × N tags × M takes never produces N×M rows.
 *   2. setEmotionalWeightBatch — composite-keyed (slug, source_id) UPDATE
 *      FROM unnest so multi-source brains can't get cross-source fan-out.
 *
 * In incremental mode (`affectedSlugs` non-empty), only those pages are
 * touched. In full mode (`affectedSlugs` undefined or null) every page in
 * the brain is recomputed — this is the path users hit on first upgrade
 * via `gbrain dream --phase recompute_emotional_weight`.
 *
 * Target wall-clock budget: <5s on a 1000-page fixture; <60s on a 50K-page
 * real brain. Catastrophic-exception path returns a 'fail' PhaseResult so
 * the cycle continues to the next phase.
 */

import type { BrainEngine } from '../engine.ts';
import type { PhaseResult, PhaseError } from '../cycle.ts';
import { computeEmotionalWeight } from './emotional-weight.ts';
import type { GBrainConfig } from '../config.ts';

export interface RecomputeEmotionalWeightOpts {
  /** When false, the phase reads + computes but skips the UPDATE. */
  dryRun?: boolean;
  /**
   * Slugs to recompute. Undefined / empty array = full brain recompute.
   * Caller passes `union(syncPagesAffected, synthesizeWrittenSlugs)` for
   * the incremental path.
   */
  affectedSlugs?: string[];
  /** GBrain config for high_emotion_tags + user_holder overrides. */
  config?: GBrainConfig;
}

export interface RecomputeEmotionalWeightResult extends PhaseResult {
  /** Number of pages whose emotional_weight was (re)computed. */
  pages_recomputed: number;
}

export async function runPhaseRecomputeEmotionalWeight(
  engine: BrainEngine,
  opts: RecomputeEmotionalWeightOpts,
): Promise<RecomputeEmotionalWeightResult> {
  const start = Date.now();
  try {
    // Resolve override tag list + user-holder from config (optional).
    const overrideTags = await engine.getConfig('emotional_weight.high_tags');
    const userHolder = await engine.getConfig('emotional_weight.user_holder');
    let highEmotionTags: ReadonlySet<string> | undefined;
    if (overrideTags) {
      try {
        const parsed = JSON.parse(overrideTags) as unknown;
        if (Array.isArray(parsed) && parsed.every(t => typeof t === 'string')) {
          highEmotionTags = new Set(parsed.map(t => t.toLowerCase()));
        }
      } catch {
        // Bad JSON — fall back to default seed list. The doctor check
        // (added separately) will surface the parse error.
      }
    }

    // Incremental path: empty array means "no changes touched" — record
    // a zero-work success and return without touching the DB.
    if (Array.isArray(opts.affectedSlugs) && opts.affectedSlugs.length === 0) {
      return result('ok', 'recompute_emotional_weight (incremental, 0 slugs)', 0, {
        mode: 'incremental',
        pages_recomputed: 0,
      }, start);
    }

    const inputs = await engine.batchLoadEmotionalInputs(opts.affectedSlugs);
    const writes = inputs.map(row => ({
      slug: row.slug,
      source_id: row.source_id,
      weight: computeEmotionalWeight(
        { tags: row.tags, takes: row.takes },
        { highEmotionTags, userHolder: userHolder ?? undefined },
      ),
    }));

    if (opts.dryRun) {
      return result('ok', `recompute_emotional_weight (dry-run, ${writes.length} pages)`, writes.length, {
        mode: opts.affectedSlugs ? 'incremental' : 'full',
        pages_recomputed: writes.length,
        dry_run: true,
      }, start);
    }

    const updated = await engine.setEmotionalWeightBatch(writes);

    return result('ok', `recompute_emotional_weight (${updated} pages)`, updated, {
      mode: opts.affectedSlugs ? 'incremental' : 'full',
      pages_recomputed: updated,
    }, start);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err: PhaseError = {
      class: 'InternalError',
      code: 'RECOMPUTE_EMOTIONAL_WEIGHT_FAIL',
      message: msg || 'recompute_emotional_weight phase threw',
    };
    return {
      phase: 'recompute_emotional_weight',
      status: 'fail',
      duration_ms: Date.now() - start,
      summary: 'recompute_emotional_weight failed',
      details: { error: err },
      error: err,
      pages_recomputed: 0,
    };
  }
}

function result(
  status: 'ok',
  summary: string,
  pagesRecomputed: number,
  details: Record<string, unknown>,
  start: number,
): RecomputeEmotionalWeightResult {
  return {
    phase: 'recompute_emotional_weight',
    status,
    duration_ms: Date.now() - start,
    summary,
    details,
    pages_recomputed: pagesRecomputed,
  };
}
