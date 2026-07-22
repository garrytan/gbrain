// v0.41 T10 — calibration domain aggregators.
//
// Closed registry of algorithms that aggregate resolved takes within a
// calibration domain. Each aggregator runs against the active pack's
// `calibration_domains: [{name, aggregator, page_types}]` declarations
// (T3 schema) and produces a per-domain scorecard for the JSONB stored
// in calibration_profiles.domain_scorecards.
//
// The aggregator algorithms are CLOSED (this enum + their SQL stays in
// code; pack manifests reference them by name). Domain NAMES are open —
// any pack can declare new domains pointing at known aggregators. See
// T3 (codex refinement of D6).
//
// JOIN shape: takes → take_domain_assignments WHERE domain = $name
// AND assignments.take_id = takes.id. Pages filtering happens via
// page_types: [...] from the domain declaration — JOIN pages too and
// filter by p.type = ANY($page_types::text[]).

import type { BrainEngine } from '../engine.ts';
import type { AggregatorKind, CalibrationDomain } from '../schema-pack/manifest-v1.ts';

export interface DomainScorecard {
  /** Number of resolved takes contributing to this scorecard. */
  n: number;
  /** Brier score (lower = better). null when n === 0 or aggregator doesn't compute one. */
  brier: number | null;
  /** Accuracy fraction in [0, 1]. null when n === 0 or aggregator doesn't compute one. */
  accuracy: number | null;
  /** Aggregator algorithm used. Stamped for downstream debugging. */
  aggregator: AggregatorKind;
  /** Page types whose takes feed this domain (per pack manifest). */
  page_types: string[];
  /** Aggregator-specific extras. cluster_summary fills tier_counts here. */
  extras?: Record<string, unknown>;
}

export type DomainScorecards = Record<string, DomainScorecard>;

/**
 * Aggregate every declared calibration_domain for the given holder.
 *
 * Returns a Record<domain_name, DomainScorecard>. Empty domains (n=0)
 * are STILL included in the result so consumers can distinguish
 * "domain is declared but has no resolved takes yet" from "domain
 * isn't declared by the active pack" (the latter case never appears
 * in this return shape).
 *
 * Fail-soft per domain: if one domain's SQL throws (e.g. the pack
 * declares a page_type that doesn't exist in the brain yet), the
 * domain gets {n: 0, brier: null, accuracy: null, extras: {error: msg}}
 * and the rest of the domains still aggregate. The phase keeps running.
 */
export async function aggregateDomainScorecards(
  engine: BrainEngine,
  holder: string,
  domains: CalibrationDomain[],
  sourceId: string,
): Promise<DomainScorecards> {
  const out: DomainScorecards = {};
  for (const domain of domains) {
    try {
      const scorecard = await aggregateOneDomain(engine, holder, domain, sourceId);
      out[domain.name] = scorecard;
    } catch (err) {
      out[domain.name] = {
        n: 0,
        brier: null,
        accuracy: null,
        aggregator: domain.aggregator,
        page_types: [...domain.page_types],
        extras: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  return out;
}

async function aggregateOneDomain(
  engine: BrainEngine,
  holder: string,
  domain: CalibrationDomain,
  sourceId: string,
): Promise<DomainScorecard> {
  switch (domain.aggregator) {
    case 'scalar_brier':
      return aggregateScalarBrier(engine, holder, domain, sourceId);
    case 'weighted_brier':
      return aggregateWeightedBrier(engine, holder, domain, sourceId);
    case 'count_based':
      return aggregateCountBased(engine, holder, domain, sourceId);
    case 'cluster_summary':
      return aggregateClusterSummary(engine, holder, domain, sourceId);
  }
}

/**
 * Standard Brier score over resolved binary takes.
 * Brier = mean((p - outcome)^2) where p = take.weight (probability),
 * outcome = resolved_outcome::int (0 or 1).
 */
async function aggregateScalarBrier(
  engine: BrainEngine,
  holder: string,
  domain: CalibrationDomain,
  sourceId: string,
): Promise<DomainScorecard> {
  const rows = await engine.executeRaw<{
    n: number;
    brier: number | null;
    accuracy: number | null;
  }>(
    `SELECT
       COUNT(*)::int AS n,
       AVG(POWER(t.weight - (t.resolved_outcome::int)::real, 2))::real AS brier,
       (SUM(CASE WHEN (t.weight >= 0.5) = t.resolved_outcome THEN 1 ELSE 0 END)::real
          / NULLIF(COUNT(*), 0))::real AS accuracy
     FROM takes t
     JOIN take_domain_assignments a ON a.take_id = t.id
     JOIN pages p ON p.id = t.page_id
     WHERE a.domain = $1
       AND t.holder = $2
       AND t.active = TRUE
       AND t.resolved_outcome IS NOT NULL
       AND p.type = ANY($3::text[])
       AND p.source_id = $4`,
    [domain.name, holder, domain.page_types, sourceId],
  );
  const row = rows[0] ?? { n: 0, brier: null, accuracy: null };
  return {
    n: row.n,
    brier: row.n > 0 ? row.brier : null,
    accuracy: row.n > 0 ? row.accuracy : null,
    aggregator: 'scalar_brier',
    page_types: [...domain.page_types],
  };
}

/**
 * Weighted Brier — weight each prediction by its CONVICTION (ABS(weight - 0.5) * 2).
 * Low-conviction (weight ≈ 0.5) hunches count less than high-conviction calls.
 * Mirrors the "market_call cares more about strong-conviction misses" semantics
 * from the investor pack.
 */
async function aggregateWeightedBrier(
  engine: BrainEngine,
  holder: string,
  domain: CalibrationDomain,
  sourceId: string,
): Promise<DomainScorecard> {
  const rows = await engine.executeRaw<{
    n: number;
    brier: number | null;
    accuracy: number | null;
  }>(
    `WITH scored AS (
       SELECT
         POWER(t.weight - (t.resolved_outcome::int)::real, 2) AS sq_err,
         ABS(t.weight - 0.5) * 2.0 AS conviction,
         (t.weight >= 0.5) = t.resolved_outcome AS hit
       FROM takes t
       JOIN take_domain_assignments a ON a.take_id = t.id
       JOIN pages p ON p.id = t.page_id
       WHERE a.domain = $1
         AND t.holder = $2
         AND t.active = TRUE
         AND t.resolved_outcome IS NOT NULL
         AND p.type = ANY($3::text[])
         AND p.source_id = $4
     )
     SELECT
       COUNT(*)::int AS n,
       (SUM(sq_err * conviction) / NULLIF(SUM(conviction), 0))::real AS brier,
       (SUM(CASE WHEN hit THEN 1 ELSE 0 END)::real / NULLIF(COUNT(*), 0))::real AS accuracy
     FROM scored`,
    [domain.name, holder, domain.page_types, sourceId],
  );
  const row = rows[0] ?? { n: 0, brier: null, accuracy: null };
  return {
    n: row.n,
    brier: row.n > 0 ? row.brier : null,
    accuracy: row.n > 0 ? row.accuracy : null,
    aggregator: 'weighted_brier',
    page_types: [...domain.page_types],
  };
}

/**
 * Simple accuracy ratio (correct / resolved). Use when binary outcomes
 * don't have natural probability semantics — e.g., "did the event happen
 * at all" rather than "what's the probability it happens."
 */
async function aggregateCountBased(
  engine: BrainEngine,
  holder: string,
  domain: CalibrationDomain,
  sourceId: string,
): Promise<DomainScorecard> {
  const rows = await engine.executeRaw<{ n: number; accuracy: number | null }>(
    `SELECT
       COUNT(*)::int AS n,
       (SUM(CASE WHEN (t.weight >= 0.5) = t.resolved_outcome THEN 1 ELSE 0 END)::real
          / NULLIF(COUNT(*), 0))::real AS accuracy
     FROM takes t
     JOIN take_domain_assignments a ON a.take_id = t.id
     JOIN pages p ON p.id = t.page_id
     WHERE a.domain = $1
       AND t.holder = $2
       AND t.active = TRUE
       AND t.resolved_outcome IS NOT NULL
       AND p.type = ANY($3::text[])
       AND p.source_id = $4`,
    [domain.name, holder, domain.page_types, sourceId],
  );
  const row = rows[0] ?? { n: 0, accuracy: null };
  return {
    n: row.n,
    brier: null,
    accuracy: row.n > 0 ? row.accuracy : null,
    aggregator: 'count_based',
    page_types: [...domain.page_types],
  };
}

/**
 * Descriptive rollup for domains where Brier doesn't apply (concept_themes
 * — concepts don't have binary outcomes to score). Returns count of pages
 * matching the domain's page_types plus tier histogram when frontmatter
 * carries `tier: T1|T2|T3|T4`.
 *
 * v0.41 minimal: returns n=page count, brier=null, accuracy=null, extras
 * carries tier_counts when available. v0.42+ can enrich with dominant
 * topics + recency + cross-source breadth.
 */
async function aggregateClusterSummary(
  engine: BrainEngine,
  holder: string,
  domain: CalibrationDomain,
  sourceId: string,
): Promise<DomainScorecard> {
  // For cluster_summary, "holder" is informational only — concepts aren't
  // owned by a holder the way takes are. We still scope by source.
  const rows = await engine.executeRaw<{
    n: number;
    t1: number;
    t2: number;
    t3: number;
    t4: number;
  }>(
    `SELECT
       COUNT(*)::int AS n,
       SUM(CASE WHEN frontmatter->>'tier' = 'T1' OR frontmatter->>'tier' = '1' THEN 1 ELSE 0 END)::int AS t1,
       SUM(CASE WHEN frontmatter->>'tier' = 'T2' OR frontmatter->>'tier' = '2' THEN 1 ELSE 0 END)::int AS t2,
       SUM(CASE WHEN frontmatter->>'tier' = 'T3' OR frontmatter->>'tier' = '3' THEN 1 ELSE 0 END)::int AS t3,
       SUM(CASE WHEN frontmatter->>'tier' = 'T4' OR frontmatter->>'tier' = '4' THEN 1 ELSE 0 END)::int AS t4
     FROM pages
     WHERE type = ANY($1::text[])
       AND source_id = $2
       AND deleted_at IS NULL`,
    [domain.page_types, sourceId],
  );
  const row = rows[0] ?? { n: 0, t1: 0, t2: 0, t3: 0, t4: 0 };
  // holder is unused for cluster_summary but documented for symmetry
  void holder;
  return {
    n: row.n,
    brier: null,
    accuracy: null,
    aggregator: 'cluster_summary',
    page_types: [...domain.page_types],
    extras: {
      tier_counts: {
        T1: row.t1 ?? 0,
        T2: row.t2 ?? 0,
        T3: row.t3 ?? 0,
        T4: row.t4 ?? 0,
      },
    },
  };
}
