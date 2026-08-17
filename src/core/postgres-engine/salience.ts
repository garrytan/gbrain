/**
 * v0.29 — Salience + Anomaly Detection, peeled out of PostgresEngine
 * (containment sprint C15). Free functions over a NARROW deps surface —
 * never the whole engine class.
 */
import type postgres from 'postgres';

type PgSql = ReturnType<typeof postgres>;

import { clampSearchLimit } from '../engine.ts';
import type {
  SalienceOpts, SalienceResult, AnomaliesOpts, AnomalyResult,
  EmotionalWeightInputRow, EmotionalWeightWriteRow,
  EnrichCandidatesOpts, EnrichCandidate,
} from '../types.ts';
import { ENRICH_ORDER_SQL } from '../types.ts';
import {
  resolveRecencyDecayMap,
  DEFAULT_FALLBACK,
} from '../search/recency-decay.ts';
import { buildRecencyComponentSql } from '../search/sql-ranking.ts';
import { computeAnomaliesFromBuckets } from '../cycle/anomaly.ts';

/** Narrow slice of PostgresEngine the salience/anomaly operations use. */
export interface PgSalienceDeps {
  /** Live postgres.js pool (getter-backed at the call site). */
  readonly sql: PgSql;
}

export async function batchLoadEmotionalInputs(deps: PgSalienceDeps, slugs?: string[]): Promise<EmotionalWeightInputRow[]> {
    const sql = deps.sql;
    // Two CTEs avoid the N×M cartesian product (codex C4#4): a page with N tags
    // and M takes joined directly would emit N×M rows and corrupt aggregates.
    // Per-table aggregation keeps each table's grouping correct.
    const rows = slugs
      ? await sql`
          WITH page_tags AS (
            SELECT page_id, array_agg(DISTINCT tag) AS tags
              FROM tags GROUP BY page_id
          ),
          page_takes AS (
            SELECT page_id, json_agg(json_build_object(
                     'holder', holder, 'weight', weight, 'kind', kind, 'active', active
                   )) AS takes
              FROM takes WHERE active = TRUE GROUP BY page_id
          )
          SELECT p.slug, p.source_id,
                 COALESCE(pt.tags, ARRAY[]::text[]) AS tags,
                 COALESCE(pk.takes, '[]'::json) AS takes
            FROM pages p
            LEFT JOIN page_tags pt  ON pt.page_id = p.id
            LEFT JOIN page_takes pk ON pk.page_id = p.id
           WHERE p.slug = ANY(${slugs}::text[])
        `
      : await sql`
          WITH page_tags AS (
            SELECT page_id, array_agg(DISTINCT tag) AS tags
              FROM tags GROUP BY page_id
          ),
          page_takes AS (
            SELECT page_id, json_agg(json_build_object(
                     'holder', holder, 'weight', weight, 'kind', kind, 'active', active
                   )) AS takes
              FROM takes WHERE active = TRUE GROUP BY page_id
          )
          SELECT p.slug, p.source_id,
                 COALESCE(pt.tags, ARRAY[]::text[]) AS tags,
                 COALESCE(pk.takes, '[]'::json) AS takes
            FROM pages p
            LEFT JOIN page_tags pt  ON pt.page_id = p.id
            LEFT JOIN page_takes pk ON pk.page_id = p.id
        `;
    return rows.map((r: Record<string, unknown>) => ({
      slug: String(r.slug),
      source_id: String(r.source_id),
      tags: (r.tags as string[]) ?? [],
      takes: (r.takes as EmotionalWeightInputRow['takes']) ?? [],
    }));
  }

export async function setEmotionalWeightBatch(deps: PgSalienceDeps, rows: EmotionalWeightWriteRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const sql = deps.sql;
    const slugs = rows.map(r => r.slug);
    const sourceIds = rows.map(r => r.source_id);
    const weights = rows.map(r => r.weight);
    // Composite-keyed UPDATE FROM unnest (codex C4#3): pages.slug is unique
    // only within a source, so a slug-only join would fan out across sources.
    //
    // v0.29.1: bump salience_touched_at to NOW() ONLY when emotional_weight
    // actually changes. The salience query window then includes the page in
    // GREATEST(updated_at, salience_touched_at) >= boundary, so a previously
    // calm page that just became salient surfaces in the recent salience
    // results without a content edit. No-op writes (same weight) leave
    // salience_touched_at alone — preserves "actual change" semantics.
    const result = await sql`
      UPDATE pages
         SET emotional_weight = u.weight,
             salience_touched_at = CASE
               WHEN pages.emotional_weight IS DISTINCT FROM u.weight THEN now()
               ELSE pages.salience_touched_at
             END
        FROM unnest(${slugs}::text[], ${sourceIds}::text[], ${weights}::real[])
          AS u(slug, source_id, weight)
       WHERE pages.slug = u.slug AND pages.source_id = u.source_id
      RETURNING 1
    `;
    return result.length;
  }

export async function getRecentSalience(deps: PgSalienceDeps, opts: SalienceOpts): Promise<SalienceResult[]> {
    const sql = deps.sql;
    const days = Math.max(0, opts.days ?? 14);
    const limit = clampSearchLimit(opts.limit, 20, 100);
    const slugPrefix = opts.slugPrefix;
    // Compute the boundary in JS so the SQL is identical across engines (eng review D5).
    const boundaryIso = new Date(Date.now() - days * 86400000).toISOString();
    // Escape LIKE meta for the optional prefix match.
    const prefixCondition = slugPrefix
      ? sql`AND p.slug LIKE ${slugPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%'} ESCAPE '\\'`
      : sql``;
    // TIM-37: exclude briefing pages from their own Brain Pulse. The cron
    // briefing writes to 90_Briefings/, gets re-ingested, and would otherwise
    // top tomorrow's salience as pure self-reference. Suppress unless the
    // caller explicitly asked for the briefings/ prefix.
    const excludeBriefings = !(slugPrefix && slugPrefix.startsWith('briefings'))
      ? sql`AND p.slug NOT LIKE 'briefings/%'`
      : sql``;
    // v0.29.1: third score term via buildRecencyComponentSql. Default
    // 'flat' = v0.29.0 behavior (1 / (1 + days_old)). 'on' opts into the
    // per-prefix decay map (concepts/ evergreen, daily/ aggressive, etc.).
    const recencyBias = opts.recency_bias ?? 'flat';
    let recencySql: string;
    if (recencyBias === 'on') {
      recencySql = buildRecencyComponentSql({
        slugColumn: 'p.slug',
        dateExpr: 'COALESCE(p.effective_date, p.updated_at)',
        decayMap: resolveRecencyDecayMap(),
        fallback: DEFAULT_FALLBACK,
      });
    } else {
      recencySql = buildRecencyComponentSql({
        slugColumn: 'p.slug',
        dateExpr: 'p.updated_at',
        decayMap: {},
        fallback: { halflifeDays: 1, coefficient: 1.0 },
      });
    }
    const rows = await sql`
      SELECT p.slug, p.source_id, p.title, p.type, p.updated_at, p.emotional_weight,
             COUNT(DISTINCT t.id) AS take_count,
             COALESCE(AVG(t.weight), 0) AS take_avg_weight,
             (p.emotional_weight * 5)
               + ln(1 + COUNT(DISTINCT t.id))
               + ${sql.unsafe(recencySql)}
               AS score
        FROM pages p
        LEFT JOIN takes t ON t.page_id = p.id AND t.active = TRUE
       WHERE GREATEST(p.updated_at, COALESCE(p.salience_touched_at, p.updated_at)) >= ${boundaryIso}::timestamptz
         ${prefixCondition}
         ${excludeBriefings}
       GROUP BY p.id
       ORDER BY score DESC
       LIMIT ${limit}
    `;
    return rows.map((r: Record<string, unknown>) => ({
      slug: String(r.slug),
      source_id: String(r.source_id),
      title: String(r.title ?? ''),
      type: r.type as SalienceResult['type'],
      updated_at: r.updated_at as Date,
      emotional_weight: Number(r.emotional_weight ?? 0),
      take_count: Number(r.take_count ?? 0),
      take_avg_weight: Number(r.take_avg_weight ?? 0),
      score: Number(r.score ?? 0),
    }));
  }

export async function listEnrichCandidates(deps: PgSalienceDeps, opts: EnrichCandidatesOpts): Promise<EnrichCandidate[]> {
    // v0.41.39 (issue #1700). Empty types → no rows (no SQL).
    if (!opts.types || opts.types.length === 0) return [];
    const sql = deps.sql;
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 5000));
    const threshold = Math.max(0, opts.thinThreshold);

    // Source scope: array wins over scalar (canonical precedence).
    const sourceCondition = opts.sourceIds && opts.sourceIds.length > 0
      ? sql`AND p.source_id = ANY(${opts.sourceIds}::text[])`
      : opts.sourceId
        ? sql`AND p.source_id = ${opts.sourceId}`
        : sql``;

    // Re-enrich recency guard. enriched_at is written as toISOString() so a
    // lexical text comparison is correct AND can't throw on a malformed value
    // (a ::timestamptz cast would). Pages never enriched (NULL) are eligible.
    const reenrichMs = opts.reenrichAfterMs ?? 0;
    const recencyCondition = reenrichMs > 0
      ? sql`AND NOT (
            p.frontmatter ->> 'enriched_at' IS NOT NULL
            AND p.frontmatter ->> 'enriched_at' > ${new Date(Date.now() - reenrichMs).toISOString()}
          )`
      : sql``;

    // Exclude dream/synthesize-generated pages (reflections, originals, cycle
    // logs carrying frontmatter dream_generated:true). enrich develops ENTITY
    // stubs; running it on a generated essay/log creates circular self-citation
    // and drops the H1. IS DISTINCT FROM 'true' keeps NULL/'false' rows.
    const dreamCondition = sql`AND (p.frontmatter ->> 'dream_generated') IS DISTINCT FROM 'true'`;

    // Whitelisted ORDER BY (no injection — enum maps to a literal fragment).
    const orderKey = ENRICH_ORDER_SQL[opts.order] ? opts.order : 'inbound-links';
    const orderBy = sql.unsafe(ENRICH_ORDER_SQL[orderKey]);

    const rows = await sql`
      SELECT
        p.slug,
        p.source_id,
        p.title,
        p.type,
        (char_length(p.compiled_truth) + char_length(COALESCE(p.timeline, ''))) AS body_len,
        COALESCE((
          SELECT COUNT(*)
            FROM links l
           WHERE l.to_page_id = p.id
             AND l.link_source IS DISTINCT FROM 'mentions'
        ), 0)::int AS inbound_count
      FROM pages p
      WHERE p.deleted_at IS NULL
        AND p.type = ANY(${opts.types}::text[])
        AND (char_length(p.compiled_truth) + char_length(COALESCE(p.timeline, ''))) < ${threshold}
        ${sourceCondition}
        ${recencyCondition}
        ${dreamCondition}
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `;
    return rows.map((r: Record<string, unknown>) => ({
      slug: String(r.slug),
      source_id: String(r.source_id),
      title: String(r.title ?? ''),
      type: r.type as EnrichCandidate['type'],
      body_len: Number(r.body_len ?? 0),
      inbound_count: Number(r.inbound_count ?? 0),
    }));
  }

export async function findAnomalies(deps: PgSalienceDeps, opts: AnomaliesOpts): Promise<AnomalyResult[]> {
    const sql = deps.sql;
    const sigma = opts.sigma ?? 3.0;
    const lookbackDays = Math.max(1, opts.lookback_days ?? 30);
    // Boundaries: today's window is [since, since+1day); baseline is [since-lookback, since).
    const sinceIso = (opts.since ?? new Date().toISOString().slice(0, 10)); // YYYY-MM-DD
    const sinceDate = new Date(sinceIso + 'T00:00:00Z');
    const sinceEnd = new Date(sinceDate.getTime() + 86400000);
    const baselineStart = new Date(sinceDate.getTime() - lookbackDays * 86400000);

    // Tag cohort baseline with day densification + zero-fill (codex C4#6).
    const tagBaseline = await sql`
      WITH days AS (
        SELECT day::date FROM generate_series(
          ${baselineStart.toISOString()}::date,
          ${sinceDate.toISOString()}::date - 1,
          '1 day'::interval
        ) AS day
      ),
      cohort_keys AS (
        SELECT DISTINCT t.tag FROM tags t JOIN pages p ON p.id = t.page_id
         WHERE p.updated_at >= ${baselineStart.toISOString()}::timestamptz
           AND p.updated_at <  ${sinceDate.toISOString()}::timestamptz
      ),
      touched AS (
        SELECT t.tag,
               date_trunc('day', p.updated_at)::date AS day,
               COUNT(DISTINCT p.id) AS cnt
          FROM tags t JOIN pages p ON p.id = t.page_id
         WHERE p.updated_at >= ${baselineStart.toISOString()}::timestamptz
           AND p.updated_at <  ${sinceDate.toISOString()}::timestamptz
         GROUP BY 1, 2
      )
      SELECT cd.tag AS cohort_value, d.day::text AS day, COALESCE(t.cnt, 0)::int AS count
        FROM cohort_keys cd CROSS JOIN days d
        LEFT JOIN touched t ON t.tag = cd.tag AND t.day = d.day
    `;

    const typeBaseline = await sql`
      WITH days AS (
        SELECT day::date FROM generate_series(
          ${baselineStart.toISOString()}::date,
          ${sinceDate.toISOString()}::date - 1,
          '1 day'::interval
        ) AS day
      ),
      cohort_keys AS (
        SELECT DISTINCT p.type FROM pages p
         WHERE p.updated_at >= ${baselineStart.toISOString()}::timestamptz
           AND p.updated_at <  ${sinceDate.toISOString()}::timestamptz
      ),
      touched AS (
        SELECT p.type,
               date_trunc('day', p.updated_at)::date AS day,
               COUNT(DISTINCT p.id) AS cnt
          FROM pages p
         WHERE p.updated_at >= ${baselineStart.toISOString()}::timestamptz
           AND p.updated_at <  ${sinceDate.toISOString()}::timestamptz
         GROUP BY 1, 2
      )
      SELECT cd.type AS cohort_value, d.day::text AS day, COALESCE(t.cnt, 0)::int AS count
        FROM cohort_keys cd CROSS JOIN days d
        LEFT JOIN touched t ON t.type = cd.type AND t.day = d.day
    `;

    // Today's window — current counts + slugs per cohort.
    const tagToday = await sql`
      SELECT t.tag AS cohort_value,
             COUNT(DISTINCT p.id)::int AS count,
             array_agg(DISTINCT p.slug) AS slugs
        FROM tags t JOIN pages p ON p.id = t.page_id
       WHERE p.updated_at >= ${sinceIso}::timestamptz
         AND p.updated_at <  ${sinceEnd.toISOString()}::timestamptz
       GROUP BY 1
    `;
    const typeToday = await sql`
      SELECT p.type AS cohort_value,
             COUNT(DISTINCT p.id)::int AS count,
             array_agg(DISTINCT p.slug) AS slugs
        FROM pages p
       WHERE p.updated_at >= ${sinceIso}::timestamptz
         AND p.updated_at <  ${sinceEnd.toISOString()}::timestamptz
       GROUP BY 1
    `;

    const baseline = [
      ...tagBaseline.map((r: Record<string, unknown>) => ({
        cohort_kind: 'tag' as const,
        cohort_value: String(r.cohort_value),
        day: String(r.day),
        count: Number(r.count),
      })),
      ...typeBaseline.map((r: Record<string, unknown>) => ({
        cohort_kind: 'type' as const,
        cohort_value: String(r.cohort_value),
        day: String(r.day),
        count: Number(r.count),
      })),
    ];
    const today = [
      ...tagToday.map((r: Record<string, unknown>) => ({
        cohort_kind: 'tag' as const,
        cohort_value: String(r.cohort_value),
        count: Number(r.count),
        page_slugs: (r.slugs as string[]) ?? [],
      })),
      ...typeToday.map((r: Record<string, unknown>) => ({
        cohort_kind: 'type' as const,
        cohort_value: String(r.cohort_value),
        count: Number(r.count),
        page_slugs: (r.slugs as string[]) ?? [],
      })),
    ];

    return computeAnomaliesFromBuckets(baseline, today, sigma);
  }
