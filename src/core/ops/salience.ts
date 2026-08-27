/**
 * Salience + Anomaly operation cluster — pure move from operations.ts
 * (v0.46.x tranche 2). Op consts stay module-private; `salienceOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts (find_anomalies was defined after
 * the push-context divider in the original file but has always occupied the
 * slot right after get_recent_salience in the array — the array order is
 * the contract). Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { sourceScopeOpts } from './context.ts';
import {
  GET_RECENT_SALIENCE_DESCRIPTION,
  FIND_ANOMALIES_DESCRIPTION,
} from '../operations-descriptions.ts';
import {
  dropPrivateOnlyRows,
  findWorldVisibleSlugs,
  resolveExcludePrivatePages,
} from '../search/private-visibility.ts';

// --- v0.29: Salience + Anomaly Detection ---

const get_recent_salience: Operation = {
  name: 'get_recent_salience',
  description: GET_RECENT_SALIENCE_DESCRIPTION,
  scope: 'read',
  params: {
    days: { type: 'number', description: 'Window in days. Default 14.' },
    limit: { type: 'number', description: 'Max results (default 20, capped at 100).' },
    slugPrefix: {
      type: 'string',
      description: "Optional slug-prefix filter, e.g. 'personal' or 'wiki/people'.",
    },
    recency_bias: {
      type: 'string',
      enum: ['flat', 'on'],
      description:
        "v0.29.1: how to weight recency in the salience score.\n" +
        "  'flat' (DEFAULT) — v0.29.0 behavior. Every page gets 1/(1+days_old).\n" +
        "                     Stable, predictable; what most callers want.\n" +
        "  'on'             — Per-prefix decay map. concepts/originals/writing/\n" +
        "                     become evergreen (recency component = 0); daily/,\n" +
        "                     media/x/, chat/ decay aggressively. Use when the\n" +
        "                     user explicitly biases for recency-aware salience\n" +
        "                     ('what's been salient lately' vs 'what matters\n" +
        "                     in this brain regardless of when').",
    },
  },
  handler: async (ctx, p) => {
    const recencyBias = p.recency_bias === 'on' ? 'on' : 'flat';
    // Scope by the caller's source (canonical sourceScopeOpts ladder: federated
    // array > scalar > nothing), matching find_orphans/find_experts. Pre-fix
    // this op returned brain-wide salience regardless of a source-bound OAuth
    // client's grant — a read leak in the v0.34.1 (#861) source-isolation class
    // that the v0.29 salience/anomaly batch missed. Trusted local callers
    // (ctx.remote === false) still get the empty scope = full brain.
    const rows = await ctx.engine.getRecentSalience({
      days: typeof p.days === 'number' ? p.days : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      slugPrefix: typeof p.slugPrefix === 'string' ? p.slugPrefix : undefined,
      recency_bias: recencyBias,
      ...sourceScopeOpts(ctx),
    });
    // A `visibility: private` page's slug/title/metadata must not reach
    // remote readers through the salience list (same read-leak class as the
    // delta page arm). The salience read is source-scoped above; the private
    // probe deliberately keeps the EMPTY scope — a broader privacy check can
    // only remove more rows (fail-closed), never leak, so don't narrow it.
    return dropPrivateOnlyRows(ctx.engine, ctx.remote, rows, r => r.slug, {});
  },
  // hidden: 'salience' is in CLI_ONLY (src/cli.ts) — runSalience owns the CLI
  // surface; the non-hidden hint was dead (CLI_ONLY wins at dispatch).
  cliHints: { name: 'salience', hidden: true },
};

const find_anomalies: Operation = {
  name: 'find_anomalies',
  description: FIND_ANOMALIES_DESCRIPTION,
  scope: 'read',
  params: {
    since: {
      type: 'string',
      description: 'ISO date YYYY-MM-DD. Default = today (UTC).',
    },
    lookback_days: {
      type: 'number',
      description: 'Days of history for the baseline. Default 30.',
    },
    sigma: {
      type: 'number',
      description: 'Sigma threshold. Default 3.0.',
    },
  },
  handler: async (ctx, p) => {
    // Scope by the caller's source (same v0.34.1 #861 source-isolation class as
    // get_recent_salience above — the v0.29 batch missed both). Applied to the
    // baseline AND today windows inside the engine so the anomaly math stays
    // self-consistent. Trusted local callers (ctx.remote === false) get the
    // empty scope = full brain.
    const anomalies = await ctx.engine.findAnomalies({
      since: typeof p.since === 'string' ? p.since : undefined,
      lookback_days: typeof p.lookback_days === 'number' ? p.lookback_days : undefined,
      sigma: typeof p.sigma === 'number' ? p.sigma : undefined,
      ...sourceScopeOpts(ctx),
    });
    // AnomalyResult.page_slugs can name `visibility: private` pages — a
    // private slug is still page metadata a remote reader must not see.
    // Leak shapes closed together for remote callers: the slug list is
    // filtered; rows whose visible slugs empty out are dropped (an
    // empty-but-present row is a hidden-activity oracle, and its
    // cohort_value can be a tag name sourced only from private pages);
    // `count` is adjusted by the slugs actually removed — NEVER recomputed
    // from the list, which is display-capped at 50 (cycle/anomaly.ts) and
    // would clamp big cohorts; `sigma_observed` is recomputed from the
    // adjusted count with the engine's own formula so the stats stay
    // mutually consistent and the pre-filter count is not reconstructible
    // from mean + sigma*stddev; and a row that no longer clears the
    // caller's threshold on its VISIBLE pages is dropped (a sub-threshold
    // survivor is itself a hidden-activity tell). Residuals, accepted and
    // documented: for >50-page cohorts, private slugs beyond the display
    // cap are invisible to the adjustment (bounded imprecision, not an
    // exact oracle), and the flip side — a >50 cohort whose visible sample
    // is ALL private is dropped wholly even if uncapped world pages drove
    // it (fails closed toward confidentiality); baseline_mean/stddev remain
    // private-inclusive (world-only cohort aggregation is the deferred
    // row-grain TODO — the source-scope half is now discharged: both the
    // baseline and today windows are source-scoped in the engine via
    // sourceScopeOpts above).
    // includeDeleted: the anomaly queries have no deleted_at predicate, so
    // a soft-deleted private page must still count as private-only.
    if (await resolveExcludePrivatePages(ctx.engine, ctx.remote)) {
      const all = [...new Set(anomalies.flatMap(a => a.page_slugs))];
      // Keep-list probe (fail-closed): a slug hard-purged between the
      // engine read and this probe has no page row and simply isn't kept,
      // instead of being served because "no row" looked like "not private".
      const keep = await findWorldVisibleSlugs(ctx.engine, all, {});
      if (keep.size < all.length) {
        const sigmaThreshold = typeof p.sigma === 'number' ? p.sigma : 3.0;
        const filtered = anomalies.flatMap(a => {
          const kept = a.page_slugs.filter(s => keep.has(s));
          const removed = a.page_slugs.length - kept.length;
          if (removed === 0) return [a]; // untouched rows pass through verbatim
          if (kept.length === 0) return [];
          const count = a.count - removed;
          const sigma_observed =
            a.baseline_stddev > 0
              ? (count - a.baseline_mean) / a.baseline_stddev
              : count - a.baseline_mean;
          const stillAnomalous =
            a.baseline_stddev > 0
              ? count > a.baseline_mean + sigmaThreshold * a.baseline_stddev
              : count > a.baseline_mean + 1;
          if (!stillAnomalous) return [];
          return [{ ...a, page_slugs: kept, count, sigma_observed }];
        });
        // Re-sort by the PUBLISHED sigma (engine sorts by pre-filter sigma,
        // cycle/anomaly.ts) — otherwise an out-of-order pair is an
        // ordering-channel tell that a row was privately adjusted.
        return filtered.sort((x, y) => y.sigma_observed - x.sigma_observed);
      }
    }
    return anomalies;
  },
  // hidden: 'anomalies' is in CLI_ONLY (src/cli.ts) — runAnomalies owns the
  // CLI surface; the non-hidden hint was dead (CLI_ONLY wins at dispatch).
  cliHints: { name: 'anomalies', hidden: true },
};


// Ops in EXACTLY the canonical `operations` array order.
export const salienceOperations: Operation[] = [get_recent_salience, find_anomalies];
