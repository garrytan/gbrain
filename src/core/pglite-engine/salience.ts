/**
 * v0.29 — Salience + Anomaly Detection, peeled out of PGLiteEngine
 * (containment sprint C15). Free functions over a NARROW deps surface —
 * never the whole engine class.
 */
import type { PGlite } from '@electric-sql/pglite';
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

/** Narrow slice of PGLiteEngine the salience/anomaly operations use. */
export interface PgliteSalienceDeps {
  /** Live PGLite handle (getter-backed at the call site). */
  readonly db: PGlite;
}

export async function batchLoadEmotionalInputs(deps: PgliteSalienceDeps, slugs?: string[]): Promise<EmotionalWeightInputRow[]> {
    // Two CTEs avoid the N×M cartesian product (codex C4#4).
    const baseSql = `
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
    const { rows } = slugs
      ? await deps.db.query(`${baseSql} WHERE p.slug = ANY($1::text[])`, [slugs])
      : await deps.db.query(baseSql);
    return (rows as Record<string, unknown>[]).map(r => ({
      slug: String(r.slug),
      source_id: String(r.source_id),
      tags: (r.tags as string[]) ?? [],
      takes: (r.takes as EmotionalWeightInputRow['takes']) ?? [],
    }));
  }

export async function setEmotionalWeightBatch(deps: PgliteSalienceDeps, rows: EmotionalWeightWriteRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const slugs = rows.map(r => r.slug);
    const sourceIds = rows.map(r => r.source_id);
    const weights = rows.map(r => r.weight);
    // Composite-keyed UPDATE FROM unnest (codex C4#3).
    // v0.29.1: bump salience_touched_at when emotional_weight actually changes
    // so the salience query window picks up newly-salient old pages. Mirror
    // of postgres-engine.ts.
    const result = await deps.db.query(
      `UPDATE pages
          SET emotional_weight = u.weight,
              salience_touched_at = CASE
                WHEN pages.emotional_weight IS DISTINCT FROM u.weight THEN now()
                ELSE pages.salience_touched_at
              END
         FROM unnest($1::text[], $2::text[], $3::real[])
           AS u(slug, source_id, weight)
        WHERE pages.slug = u.slug AND pages.source_id = u.source_id
        RETURNING 1`,
      [slugs, sourceIds, weights]
    );
    return result.rows.length;
  }

export async function getRecentSalience(deps: PgliteSalienceDeps, opts: SalienceOpts): Promise<SalienceResult[]> {
    const days = Math.max(0, opts.days ?? 14);
    const limit = clampSearchLimit(opts.limit, 20, 100);
    const slugPrefix = opts.slugPrefix;
    const boundaryIso = new Date(Date.now() - days * 86400000).toISOString();

    const params: unknown[] = [boundaryIso];
    let prefixCondition = '';
    if (slugPrefix) {
      const escaped = slugPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      params.push(escaped);
      prefixCondition = `AND p.slug LIKE $${params.length} ESCAPE '\\'`;
    }
    // TIM-37: exclude briefing pages from their own Brain Pulse. See the
    // matching block in postgres-engine.ts getRecentSalience() for context.
    const excludeBriefings = !(slugPrefix && slugPrefix.startsWith('briefings'))
      ? `AND p.slug NOT LIKE 'briefings/%'`
      : '';
    params.push(limit);
    const limitParam = `$${params.length}`;

    // v0.29.1: third score term via buildRecencyComponentSql. Default
    // 'flat' = v0.29.0 behavior. 'on' opts into per-prefix decay.
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
    const { rows } = await deps.db.query(
      `SELECT p.slug, p.source_id, p.title, p.type, p.updated_at, p.emotional_weight,
              COUNT(DISTINCT t.id) AS take_count,
              COALESCE(AVG(t.weight), 0) AS take_avg_weight,
              (p.emotional_weight * 5)
                + ln(1 + COUNT(DISTINCT t.id))
                + ${recencySql}
                AS score
         FROM pages p
         LEFT JOIN takes t ON t.page_id = p.id AND t.active = TRUE
        WHERE GREATEST(p.updated_at, COALESCE(p.salience_touched_at, p.updated_at)) >= $1::timestamptz
          ${prefixCondition}
          ${excludeBriefings}
        GROUP BY p.id
        ORDER BY score DESC
        LIMIT ${limitParam}`,
      params
    );
    return (rows as Record<string, unknown>[]).map(r => ({
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

export async function listEnrichCandidates(deps: PgliteSalienceDeps, opts: EnrichCandidatesOpts): Promise<EnrichCandidate[]> {
    // v0.41.39 (issue #1700). Parity with postgres-engine.listEnrichCandidates.
    if (!opts.types || opts.types.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 5000));
    const threshold = Math.max(0, opts.thinThreshold);

    const params: unknown[] = [];
    params.push(opts.types);
    const typesParam = `$${params.length}`;
    params.push(threshold);
    const thresholdParam = `$${params.length}`;

    const where: string[] = [
      'p.deleted_at IS NULL',
      `p.type = ANY(${typesParam}::text[])`,
      `(char_length(p.compiled_truth) + char_length(COALESCE(p.timeline, ''))) < ${thresholdParam}`,
    ];

    // Source scope: array wins over scalar.
    if (opts.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      where.push(`p.source_id = ANY($${params.length}::text[])`);
    } else if (opts.sourceId) {
      params.push(opts.sourceId);
      where.push(`p.source_id = $${params.length}`);
    }

    // Re-enrich recency guard. Lexical text compare on the ISO `enriched_at`
    // (never cast → can't throw on a malformed value). NULL → eligible.
    const reenrichMs = opts.reenrichAfterMs ?? 0;
    if (reenrichMs > 0) {
      params.push(new Date(Date.now() - reenrichMs).toISOString());
      where.push(
        `NOT (p.frontmatter ->> 'enriched_at' IS NOT NULL AND p.frontmatter ->> 'enriched_at' > $${params.length})`,
      );
    }

    // Exclude dream/synthesize-generated pages (parity with postgres-engine).
    where.push(`(p.frontmatter ->> 'dream_generated') IS DISTINCT FROM 'true'`);

    const orderKey = ENRICH_ORDER_SQL[opts.order] ? opts.order : 'inbound-links';
    const orderBy = ENRICH_ORDER_SQL[orderKey];

    params.push(limit);
    const limitParam = `$${params.length}`;

    const { rows } = await deps.db.query(
      `SELECT
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
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT ${limitParam}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      source_id: String(r.source_id),
      title: String(r.title ?? ''),
      type: r.type as EnrichCandidate['type'],
      body_len: Number(r.body_len ?? 0),
      inbound_count: Number(r.inbound_count ?? 0),
    }));
  }

export async function findAnomalies(deps: PgliteSalienceDeps, opts: AnomaliesOpts): Promise<AnomalyResult[]> {
    const sigma = opts.sigma ?? 3.0;
    const lookbackDays = Math.max(1, opts.lookback_days ?? 30);
    const sinceIso = (opts.since ?? new Date().toISOString().slice(0, 10));
    const sinceDate = new Date(sinceIso + 'T00:00:00Z');
    const sinceEnd = new Date(sinceDate.getTime() + 86400000);
    const baselineStart = new Date(sinceDate.getTime() - lookbackDays * 86400000);

    const tagBaselineRes = await deps.db.query(
      `WITH days AS (
         SELECT day::date FROM generate_series(
           $1::date, $2::date - 1, '1 day'::interval
         ) AS day
       ),
       cohort_keys AS (
         SELECT DISTINCT t.tag FROM tags t JOIN pages p ON p.id = t.page_id
          WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
       ),
       touched AS (
         SELECT t.tag,
                date_trunc('day', p.updated_at)::date AS day,
                COUNT(DISTINCT p.id) AS cnt
           FROM tags t JOIN pages p ON p.id = t.page_id
          WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
          GROUP BY 1, 2
       )
       SELECT cd.tag AS cohort_value, d.day::text AS day, COALESCE(t.cnt, 0)::int AS count
         FROM cohort_keys cd CROSS JOIN days d
         LEFT JOIN touched t ON t.tag = cd.tag AND t.day = d.day`,
      [baselineStart.toISOString(), sinceDate.toISOString()]
    );

    const typeBaselineRes = await deps.db.query(
      `WITH days AS (
         SELECT day::date FROM generate_series(
           $1::date, $2::date - 1, '1 day'::interval
         ) AS day
       ),
       cohort_keys AS (
         SELECT DISTINCT p.type FROM pages p
          WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
       ),
       touched AS (
         SELECT p.type,
                date_trunc('day', p.updated_at)::date AS day,
                COUNT(DISTINCT p.id) AS cnt
           FROM pages p
          WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
          GROUP BY 1, 2
       )
       SELECT cd.type AS cohort_value, d.day::text AS day, COALESCE(t.cnt, 0)::int AS count
         FROM cohort_keys cd CROSS JOIN days d
         LEFT JOIN touched t ON t.type = cd.type AND t.day = d.day`,
      [baselineStart.toISOString(), sinceDate.toISOString()]
    );

    const tagTodayRes = await deps.db.query(
      `SELECT t.tag AS cohort_value,
              COUNT(DISTINCT p.id)::int AS count,
              array_agg(DISTINCT p.slug) AS slugs
         FROM tags t JOIN pages p ON p.id = t.page_id
        WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
        GROUP BY 1`,
      [sinceIso, sinceEnd.toISOString()]
    );

    const typeTodayRes = await deps.db.query(
      `SELECT p.type AS cohort_value,
              COUNT(DISTINCT p.id)::int AS count,
              array_agg(DISTINCT p.slug) AS slugs
         FROM pages p
        WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
        GROUP BY 1`,
      [sinceIso, sinceEnd.toISOString()]
    );

    const baseline = [
      ...(tagBaselineRes.rows as Record<string, unknown>[]).map(r => ({
        cohort_kind: 'tag' as const,
        cohort_value: String(r.cohort_value),
        day: String(r.day),
        count: Number(r.count),
      })),
      ...(typeBaselineRes.rows as Record<string, unknown>[]).map(r => ({
        cohort_kind: 'type' as const,
        cohort_value: String(r.cohort_value),
        day: String(r.day),
        count: Number(r.count),
      })),
    ];
    const today = [
      ...(tagTodayRes.rows as Record<string, unknown>[]).map(r => ({
        cohort_kind: 'tag' as const,
        cohort_value: String(r.cohort_value),
        count: Number(r.count),
        page_slugs: (r.slugs as string[]) ?? [],
      })),
      ...(typeTodayRes.rows as Record<string, unknown>[]).map(r => ({
        cohort_kind: 'type' as const,
        cohort_value: String(r.cohort_value),
        count: Number(r.count),
        page_slugs: (r.slugs as string[]) ?? [],
      })),
    ];

    return computeAnomaliesFromBuckets(baseline, today, sigma);
  }
