/**
 * v0.31 — Dream-cycle `consolidate` phase: facts → takes promotion.
 *
 * Per /plan-eng-review Phase 5:
 *
 *   For each (source_id, entity_slug) bucket of unconsolidated active facts:
 *     1. Skip if count < 3 OR oldest fact age < 24h.
 *     2. Cluster by embedding cosine — greedy threshold 0.85.
 *     3. For each cluster ≥ 2: pick the highest-confidence fact's text as
 *        the take claim (v0.31 ships without LLM synthesis to keep the
 *        cycle deterministic; see TODO at the bottom for the v0.32 Sonnet
 *        rewrite).
 *     4. Resolve entity_slug → pages.slug. If the page is missing, skip
 *        this cluster (no auto-page-creation in v0.31; the take needs a
 *        home).
 *     5. INSERT into takes(kind='fact', holder='self', source=concatenated
 *        source_sessions). row_num = MAX existing for the page + 1.
 *     6. UPDATE contributing facts: consolidated_at = now() +
 *        consolidated_into = takes.id. NEVER DELETE.
 *
 * The phase's totals contribute to the runCycle CycleReport via
 * extractTotals (cycle.ts) — facts_consolidated + takes_written.
 */

import type { BrainEngine, FactRow } from '../../engine.ts';
import type { PhaseResult } from '../../cycle.ts';
import { cosineSimilarity } from '../../facts/classify.ts';
import { createHash } from 'node:crypto';
import { isAborted } from '../../abort-check.ts';
import { maintenancePreflight, submitMaintenanceConsolidation } from '../../persistence/prepared-maintenance.ts';
import { managedPersistenceEnabled } from '../../persistence/ownership.ts';
import { maintenanceTransaction } from '../../persistence/attribution.ts';

export interface ConsolidatePhaseOpts {
  dryRun?: boolean;
  /** In-phase keepalive callback. Awaited between buckets. */
  yieldDuringPhase?: () => Promise<void>;
  /**
   * #1972: cooperative-abort signal. Checked at the top of the bucket loop so a
   * long consolidate relinquishes its worker slot well under the 30s
   * force-evict instead of running to completion after cancellation.
   */
  signal?: AbortSignal;
  /** Cosine cluster threshold. Overrides `cycle.consolidate.cluster_threshold`; default 0.85. */
  clusterThreshold?: number;
  /** Minimum facts per (source, entity) bucket before consolidation. Default 3. */
  minFactsPerBucket?: number;
  /** Minimum age (ms) of the OLDEST fact in a bucket before consolidation. Default 24h. */
  minOldestAgeMs?: number;
  sourceId?: string;
}

export const CLUSTER_THRESHOLD_KEY = 'cycle.consolidate.cluster_threshold';
export const DEFAULT_CLUSTER_THRESHOLD = 0.85;

/**
 * #5363: parse `cycle.consolidate.cluster_threshold`. A cosine similarity in
 * (0, 1]; lower values merge more facts into one take. Throws on anything
 * else so `gbrain config set` can refuse it.
 */
export function parseClusterThreshold(value: string): number {
  const n = Number(value.trim());
  if (value.trim() === '' || !Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`${CLUSTER_THRESHOLD_KEY} must be a number greater than 0 and at most 1 (default ${DEFAULT_CLUSTER_THRESHOLD}); got '${value}'.`);
  }
  return n;
}

export async function runPhaseConsolidate(
  engine: BrainEngine,
  opts: ConsolidatePhaseOpts = {},
): Promise<PhaseResult> {
  const dryRun = opts.dryRun === true;
  const managed = await managedPersistenceEnabled(engine);
  // #5363: the knob was unreachable (cycle.ts never passed it); the phase now
  // reads its own config key. A malformed stored value keeps the default and
  // is reported in details instead of failing the cycle.
  let thresholdInvalid: string | undefined;
  let threshold = opts.clusterThreshold;
  if (threshold === undefined) {
    const configured = await engine.getConfig(CLUSTER_THRESHOLD_KEY);
    threshold = DEFAULT_CLUSTER_THRESHOLD;
    if (configured != null && configured.trim() !== '') {
      try { threshold = parseClusterThreshold(configured); }
      catch { thresholdInvalid = configured; }
    }
  }
  const minPerBucket = opts.minFactsPerBucket ?? 3;
  const minOldestAgeMs = opts.minOldestAgeMs ?? 24 * 60 * 60 * 1000;

  let factsConsolidated = 0;
  let takesWritten = 0;
  let bucketsProcessed = 0;
  let bucketsSkipped = 0;
  let clustersSkippedRetired = 0;

  // Pull every (source_id, entity_slug) bucket of unconsolidated facts.
  // Uses the partial idx_facts_unconsolidated index.
  let buckets: Array<{ source_id: string; entity_slug: string; count: number }>;
  try {
    buckets = await engine.executeRaw<{
      source_id: string; entity_slug: string; count: number;
    }>(`
      SELECT source_id, entity_slug, COUNT(*)::int AS count
      FROM facts
      WHERE consolidated_at IS NULL
        AND expired_at IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND entity_slug IS NOT NULL
        AND ($2::boolean=false OR visibility='world')
        AND ($1::text IS NULL OR source_id=$1)
      GROUP BY source_id, entity_slug
      HAVING COUNT(*) >= $3
    `, [opts.sourceId ?? null, managed, minPerBucket]);
  } catch (err) {
    return {
      phase: 'consolidate',
      status: 'fail',
      duration_ms: 0,
      summary: 'failed to scan unconsolidated facts',
      details: { error: err instanceof Error ? err.message : String(err) },
      error: {
        class: 'ConsolidateScanFailed',
        code: 'consolidate_scan_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  for (const b of buckets) {
    // #1972: bail at the top of the bucket loop on abort. Each prior bucket's
    // per-row INSERT/consolidate is already committed, so breaking returns a
    // valid partial envelope (the inner cluster loop is bounded at limit 100,
    // so no inner guard is needed).
    if (isAborted(opts.signal)) break;
    if (opts.yieldDuringPhase) {
      try { await opts.yieldDuringPhase(); } catch { /* keepalive errors non-fatal */ }
    }

    const maintenance = managed && !dryRun ? await maintenancePreflight(engine, b.source_id) : null;
    const candidates = await engine.listFactsByEntity(b.source_id, b.entity_slug, {
      activeOnly: true,
      unconsolidatedOnly: true,
      visibility: managed ? ['world'] : undefined,
      limit: 100,
    });
    const unconsolidated = managed ? candidates.filter(f => f.visibility === 'world') : candidates;
    if (unconsolidated.length < minPerBucket) {
      bucketsSkipped += 1;
      continue;
    }

    // Age gate: oldest must be at least minOldestAgeMs old.
    const oldest = unconsolidated.reduce((min, f) =>
      f.valid_from.getTime() < min.valid_from.getTime() ? f : min,
    );
    if (Date.now() - oldest.valid_from.getTime() < minOldestAgeMs) {
      bucketsSkipped += 1;
      continue;
    }

    bucketsProcessed += 1;
    const claims = await loadClaimShapes(engine, unconsolidated.map(f => f.id));
    const clusters = clusterFacts(unconsolidated, threshold, claims);

    // Resolve entity_slug → page_id. If page missing in this source, skip.
    const pageRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
      [b.source_id, b.entity_slug],
    );
    if (pageRows.length === 0) continue;
    const pageId = pageRows[0].id;

    // Existing row_num max for this page → start appending after it.
    const rowMaxRows = await engine.executeRaw<{ max: number }>(
      `SELECT COALESCE(MAX(row_num), 0)::int AS max FROM takes WHERE page_id = $1`,
      [pageId],
    );
    let nextRowNum = (rowMaxRows[0]?.max ?? 0) + 1;

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      // Take selection: pick the highest-confidence fact's text as the
      // take claim (v0.31 deterministic). v0.32 will swap to a Sonnet
      // synthesis pass.
      const best = cluster.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      const avgWeight = cluster.reduce((s, f) => s + f.confidence, 0) / cluster.length;
      const sources = Array.from(new Set(cluster.map(c => c.source_session ?? c.source).filter(Boolean))).join(',');
      const sinceISO = cluster
        .map(c => c.valid_from)
        .reduce((min, d) => (d < min ? d : min))
        .toISOString()
        .slice(0, 10);

      if (dryRun) {
        // Pretend we did it.
        takesWritten += 1;
        factsConsolidated += cluster.length;
        nextRowNum += 1;
        continue;
      }

      if (maintenance) {
        const receipt = await submitMaintenanceConsolidation(engine, maintenance, b.entity_slug, cluster,
          { claim: best.fact, weight: clamp01(avgWeight), source: sources.slice(0, 200), since: sinceISO });
        factsConsolidated += Number(receipt.facts_consolidated ?? 0);
        takesWritten += Number(receipt.takes_written ?? 0);
        if (receipt.reason === 'retired_take') clustersSkippedRetired++;
        continue;
      }

      // v0.35.4 (D-CDX-4) — semantic upsert. The full dream cycle runs
      // `extract_facts` BEFORE `consolidate`; `extract_facts` hard-deletes
      // and re-inserts page facts via deleteFactsForPage + insertFacts,
      // which clears `consolidated_at` on every fact. Without this lookup,
      // a second cycle run would re-INSERT a duplicate take via
      // `MAX(row_num)+1`, silently poisoning trajectory + scorecard data.
      // Match on (page_id, claim) restricted to the rows this phase authors.
      //
      // `since_date` is NOT part of the identity: it is derived from
      // MIN(valid_from) of the cluster, so it describes the fact rows that
      // happen to exist right now. When extract_facts re-inserts a claim with
      // a fresh `valid_from` (the common case: an LLM extraction that defaults
      // valid_from to now()), keying on since_date makes this lookup miss and
      // the upsert degrades into the duplicate-INSERT path this block exists
      // to prevent.
      //
      // `kind = 'fact' AND holder = 'self'` mirrors the INSERT below, so the
      // lookup can only ever match a take this phase wrote. Without it the
      // widened match reaches human-authored takes that share the claim text
      // and the UPDATE below would overwrite their provenance.
      //
      // Deliberately NOT filtered on `active`: a superseded take still owns
      // this claim. Skipping it would send us down the INSERT path and
      // resurrect a claim the user retired. `ORDER BY id` keeps the choice
      // deterministic if a page already holds more than one matching row
      // (duplicates minted by the pre-fix since_date lookup).
      const existing = await engine.executeRaw<{ id: number; resolved_at: Date | null }>(
        `SELECT id, resolved_at FROM takes
         WHERE page_id = $1 AND claim = $2 AND kind = 'fact' AND holder = 'self'
         ORDER BY id
         LIMIT 1`,
        [pageId, best.fact],
      );

      let takeId: number;
      if (existing.length > 0) {
        // Re-promotion of a cluster we already wrote a take for. Refresh
        // the source-aggregation string (new fact rows may carry new
        // source_session values that the prior run didn't see); leave
        // row_num + weight untouched to keep the take's identity stable.
        takeId = existing[0].id;
        // A resolved take is immutable everywhere else (the engines throw
        // TAKE_RESOLVED_IMMUTABLE / TAKE_ALREADY_RESOLVED); this raw UPDATE
        // would bypass that guard. Reuse its id so the facts still consolidate
        // into it, but leave the row untouched.
        if (existing[0].resolved_at === null) {
          await maintenanceTransaction(engine, tx => tx.executeRaw(
            `UPDATE takes SET source = $1, updated_at = now() WHERE id = $2`,
            [sources.slice(0, 200), takeId],
          ));
        }
      } else {
        const inserted = await maintenanceTransaction(engine, tx => tx.addTakesBatch([{
          page_id: pageId,
          row_num: nextRowNum,
          claim: best.fact,
          kind: 'fact',
          holder: 'self',
          weight: clamp01(avgWeight),
          since_date: sinceISO,
          source: sources.slice(0, 200),
          active: true,
        }]));
        if (inserted < 1) continue;

        const idRows = await engine.executeRaw<{ id: number }>(
          `SELECT id FROM takes WHERE page_id = $1 AND row_num = $2`,
          [pageId, nextRowNum],
        );
        if (idRows.length === 0) {
          nextRowNum += 1;
          continue;
        }
        takeId = idRows[0].id;
        nextRowNum += 1;
        takesWritten += 1;
      }

      // Mark all contributing facts consolidated.
      await maintenanceTransaction(engine, async tx => {
        for (const f of cluster) await tx.consolidateFact(f.id, takeId);
      });
      factsConsolidated += cluster.length;

      // v0.35.4 (D-CDX-4 part 2) — chronological valid_until writeback.
      // Sort the cluster by (valid_from ASC, id ASC); walk consecutive
      // pairs; stamp the older fact's valid_until = next_newer.valid_from.
      // The newest fact keeps valid_until = NULL. This makes the facts
      // table a proper bitemporal record without the contradiction probe
      // having to mutate it (preserves auto-supersession.ts:4 invariant —
      // see also R8 test guard).
      //
      // Idempotent: re-running on the same cluster produces the same
      // chronological order and the same valid_until values. No-op if
      // valid_until is already correct.
      const chronological = [...cluster].sort((a, b) => {
        const t = a.valid_from.getTime() - b.valid_from.getTime();
        if (t !== 0) return t;
        return a.id - b.id;
      });
      await maintenanceTransaction(engine, async tx => {
        for (let i = 0; i < chronological.length - 1; i++) {
          const older = chronological[i];
          const newer = chronological[i + 1];
          await tx.executeRaw(
            // Only UPDATE when the new value would actually change. Avoids
            // touching updated_at on no-op rewrites and keeps idempotency
            // observable in the DB (zero affected rows on stable re-run).
            `UPDATE facts
               SET valid_until = $1
             WHERE id = $2
               AND (valid_until IS DISTINCT FROM $1)`,
            [newer.valid_from, older.id],
          );
        }
      });
    }
  }

  return {
    phase: 'consolidate',
    status: factsConsolidated === 0 && clustersSkippedRetired > 0 ? 'skipped' : 'ok',
    duration_ms: 0,
    summary: dryRun
      ? `(dry-run) would promote ${factsConsolidated} facts into ${takesWritten} takes across ${bucketsProcessed} buckets`
      : `promoted ${factsConsolidated} facts into ${takesWritten} takes across ${bucketsProcessed} buckets` +
        (clustersSkippedRetired ? `; skipped ${clustersSkippedRetired} clusters with retired takes` : ''),
    details: {
      dryRun,
      cluster_threshold: threshold,
      ...(thresholdInvalid !== undefined ? { cluster_threshold_invalid: thresholdInvalid } : {}),
      facts_consolidated: factsConsolidated,
      takes_written: takesWritten,
      buckets_processed: bucketsProcessed,
      buckets_skipped: bucketsSkipped,
      clusters_skipped_retired: clustersSkippedRetired,
      ...(factsConsolidated === 0 && clustersSkippedRetired > 0 ? { reason: 'retired_take' } : {}),
    },
  };
}

/** The typed-claim columns of a fact (FactRow does not carry them). */
export interface ClaimShape {
  metric: string | null;
  unit: string | null;
  period: string | null;
}

async function loadClaimShapes(engine: BrainEngine, ids: number[]): Promise<Map<number, ClaimShape>> {
  const rows = ids.length === 0 ? [] : await engine.executeRaw<{
    id: number; claim_metric: string | null; claim_unit: string | null; claim_period: string | null;
  }>(`SELECT id, claim_metric, claim_unit, claim_period FROM facts WHERE id = ANY($1::bigint[])`, [ids]);
  return new Map(rows.map(r => [Number(r.id), { metric: r.claim_metric, unit: r.claim_unit, period: r.claim_period }]));
}

/**
 * #5363: two facts may share a take only when their typed claims agree.
 * Untyped facts (no metric) cluster with untyped facts; a typed fact
 * clusters only with facts of the same metric, unit and period (a monthly
 * and an annual MRR, or USD and EUR, never merge however close their text
 * embeddings are). A fact whose claim columns are unknown is treated as
 * untyped.
 */
export function claimsCompatible(a: ClaimShape | undefined, b: ClaimShape | undefined): boolean {
  const metricA = a?.metric ?? null;
  const metricB = b?.metric ?? null;
  if (metricA === null || metricB === null) return metricA === metricB;
  return metricA === metricB && (a?.unit ?? null) === (b?.unit ?? null) && (a?.period ?? null) === (b?.period ?? null);
}

/**
 * Greedy cosine clustering. Iterate facts sorted by valid_from DESC; each
 * fact joins the first cluster whose centroid (the first member, for
 * simplicity) is within `threshold` cosine and whose typed claim is
 * compatible (#5363). Otherwise starts a new cluster.
 *
 * Facts with no embedding cluster on their own (single-element cluster);
 * the consolidate phase only writes takes from clusters of size ≥ 2, so
 * no-embedding singletons sit out the cycle. v0.32+ fact-extraction
 * pipeline ensures embeddings are computed at insertFact time.
 */
export function clusterFacts(facts: FactRow[], threshold: number, claims: Map<number, ClaimShape> = new Map()): FactRow[][] {
  const sorted = [...facts].sort((a, b) => b.valid_from.getTime() - a.valid_from.getTime());
  const clusters: FactRow[][] = [];
  for (const f of sorted) {
    if (!f.embedding || !f.embedding_model || f.embedded_text_hash !== createHash('md5').update(f.fact).digest('hex')) {
      clusters.push([f]);
      continue;
    }
    let placed = false;
    for (const c of clusters) {
      const head = c[0];
      if (!head.embedding || f.embedding_model !== head.embedding_model
        || head.embedded_text_hash !== createHash('md5').update(head.fact).digest('hex')
        || f.embedding.length !== head.embedding.length
        || !claimsCompatible(claims.get(f.id), claims.get(head.id))) continue;
      if (cosineSimilarity(f.embedding, head.embedding) >= threshold) {
        c.push(f);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([f]);
  }
  return clusters;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
