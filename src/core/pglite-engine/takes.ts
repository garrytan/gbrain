/**
 * v0.28: Takes (typed/weighted/attributed claims) + synthesis_evidence,
 * peeled out of PGLiteEngine (containment sprint C15). Free functions over
 * a NARROW deps surface — never the whole engine class.
 */
import type { PGlite } from '@electric-sql/pglite';
import type {
  BatchOpts,
  TakeBatchInput, Take, TakesListOpts, TakeHit, StaleTakeRow,
  TakeResolution, SynthesisEvidenceInput,
  TakesScorecard, TakesScorecardOpts, CalibrationBucket, CalibrationCurveOpts,
} from '../engine.ts';
import { clampSearchLimit } from '../engine.ts';
import type { SearchOpts } from '../types.ts';
import { GBrainError } from '../types.ts';
import type { BatchAuditSite } from '../retry.ts';
import type { SqlValue } from '../sql-query.ts';
import { deriveResolutionTuple, finalizeScorecard } from '../takes-resolution.ts';
import { normalizeWeightForStorage } from '../takes-fence.ts';
import { buildTakeRows } from '../batch-rows.ts';
import { takeRowToTake, takeHitRowToHit } from '../utils.ts';

/** Narrow slice of PGLiteEngine the takes operations use. */
export interface PgliteTakesDeps {
  /** Live PGLite handle (getter-backed at the call site). */
  readonly db: PGlite;
  /** Engine batch retry wrapper (audit JSONL + backoff live on the engine). */
  batchRetry<T>(
    auditSite: BatchAuditSite,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
    batchSize: number,
  ): Promise<T>;
  /** JSONB-safe positional write helper, bound to the engine at the call site. */
  executeRawJsonb<R = Record<string, unknown>>(
    sql: string,
    scalarParams: SqlValue[],
    jsonbParams: unknown[],
  ): Promise<R[]>;
}

export async function addTakesBatch(deps: PgliteTakesDeps, rowsIn: TakeBatchInput[], opts?: BatchOpts): Promise<number> {
    if (rowsIn.length === 0) return 0;
    // v0.42.26: wrap in batchRetry to match links/timeline (takes was the only
    // batch primitive without retry resilience).
    return deps.batchRetry(opts?.auditSite ?? 'addTakesBatch', opts?.signal, () => _addTakesBatchOnce(deps, rowsIn), rowsIn.length);
  }

async function _addTakesBatchOnce(deps: PgliteTakesDeps, rowsIn: TakeBatchInput[]): Promise<number> {
    // #1861: JSONB jsonb_to_recordset instead of unnest(${arr}::text[]). Mirrors
    // PostgresEngine: `claim` is free LLM prose (array-literal crash hazard);
    // native recordset types + JSON-native numbers/booleans retire the per-engine
    // element-type casts. Weight clamp/round + NUL strip live in buildTakeRows.
    // ON CONFLICT DO UPDATE — intra-batch dup (page_id, row_num) errors, same as
    // the pre-#1861 unnest path.
    const { rows, weightClamped } = buildTakeRows(rowsIn);
    if (weightClamped > 0) {
      process.stderr.write(`[takes] TAKES_WEIGHT_CLAMPED: ${weightClamped} row(s) had weight outside [0,1]; clamped\n`);
    }
    const result = await deps.executeRawJsonb(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, until_date, source, superseded_by, active)
       SELECT v.page_id, v.row_num, v.claim, v.kind, v.holder, v.weight,
              v.since_date, v.until_date, v.source, v.superseded_by, v.active
       FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(
         page_id int, row_num int, claim text, kind text, holder text, weight real,
         since_date text, until_date text, source text, superseded_by int, active boolean
       )
       ON CONFLICT (page_id, row_num) DO UPDATE SET
         claim         = EXCLUDED.claim,
         kind          = EXCLUDED.kind,
         holder        = EXCLUDED.holder,
         weight        = EXCLUDED.weight,
         since_date    = EXCLUDED.since_date,
         until_date    = EXCLUDED.until_date,
         source        = EXCLUDED.source,
         superseded_by = EXCLUDED.superseded_by,
         active        = EXCLUDED.active,
         updated_at    = now()
       RETURNING 1`,
      [],
      [{ rows }],
    );
    return result.length;
  }

  /** v0.32.6 P1 — batched per-page active-takes fetch for the contradiction probe. */
export async function listActiveTakesForPages(
  deps: PgliteTakesDeps,
    pageIds: number[],
    opts: { takesHoldersAllowList?: string[] } = {},
  ): Promise<Map<number, Take[]>> {
    const out = new Map<number, Take[]>();
    for (const pid of pageIds) out.set(pid, []);
    if (pageIds.length === 0) return out;
    const { rows } = await deps.db.query(
      `SELECT t.*, p.slug AS page_slug
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE t.page_id = ANY($1::int[])
         AND t.active = true
         AND ($2::text[] IS NULL OR t.holder = ANY($2::text[]))
       ORDER BY t.page_id, t.row_num`,
      [pageIds, opts.takesHoldersAllowList ?? null]
    );
    for (const r of rows) {
      const take = takeRowToTake(r as Record<string, unknown>);
      const bucket = out.get(take.page_id);
      if (bucket) bucket.push(take);
    }
    return out;
  }

  /** v0.32.6 M5 — persist a probe run row. Idempotent on run_id. */
export async function writeContradictionsRun(deps: PgliteTakesDeps, row: {
    run_id: string;
    judge_model: string;
    prompt_version: string;
    queries_evaluated: number;
    queries_with_contradiction: number;
    total_contradictions_flagged: number;
    wilson_ci_lower: number;
    wilson_ci_upper: number;
    judge_errors_total: number;
    cost_usd_total: number;
    duration_ms: number;
    source_tier_breakdown: Record<string, unknown>;
    report_json: Record<string, unknown>;
  }): Promise<boolean> {
    const result = await deps.db.query(
      `INSERT INTO eval_contradictions_runs (
         run_id, judge_model, prompt_version,
         queries_evaluated, queries_with_contradiction, total_contradictions_flagged,
         wilson_ci_lower, wilson_ci_upper, judge_errors_total,
         cost_usd_total, duration_ms,
         source_tier_breakdown, report_json
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6,
         $7, $8, $9,
         $10, $11,
         $12::jsonb, $13::jsonb
       )
       ON CONFLICT (run_id) DO NOTHING`,
      [
        row.run_id, row.judge_model, row.prompt_version,
        row.queries_evaluated, row.queries_with_contradiction, row.total_contradictions_flagged,
        row.wilson_ci_lower, row.wilson_ci_upper, row.judge_errors_total,
        row.cost_usd_total, row.duration_ms,
        row.source_tier_breakdown, row.report_json,
      ]
    );
    return (result.affectedRows ?? 0) > 0;
  }

  /** v0.32.6 M5 — read probe runs from the last N days. */
export async function loadContradictionsTrend(deps: PgliteTakesDeps, days: number): Promise<Array<{
    run_id: string;
    ran_at: string;
    judge_model: string;
    queries_evaluated: number;
    queries_with_contradiction: number;
    total_contradictions_flagged: number;
    wilson_ci_lower: number;
    wilson_ci_upper: number;
    judge_errors_total: number;
    cost_usd_total: number;
    duration_ms: number;
    source_tier_breakdown: Record<string, unknown>;
    report_json: Record<string, unknown>;
  }>> {
    const cutoff = new Date(Date.now() - Math.max(0, days) * 86400000);
    const { rows } = await deps.db.query(
      `SELECT run_id, ran_at, judge_model,
              queries_evaluated, queries_with_contradiction, total_contradictions_flagged,
              wilson_ci_lower, wilson_ci_upper, judge_errors_total,
              cost_usd_total, duration_ms,
              source_tier_breakdown, report_json
       FROM eval_contradictions_runs
       WHERE ran_at >= $1
       ORDER BY ran_at DESC`,
      [cutoff]
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      run_id: r.run_id as string,
      ran_at: r.ran_at instanceof Date ? (r.ran_at as Date).toISOString() : String(r.ran_at),
      judge_model: r.judge_model as string,
      queries_evaluated: Number(r.queries_evaluated),
      queries_with_contradiction: Number(r.queries_with_contradiction),
      total_contradictions_flagged: Number(r.total_contradictions_flagged),
      wilson_ci_lower: Number(r.wilson_ci_lower),
      wilson_ci_upper: Number(r.wilson_ci_upper),
      judge_errors_total: Number(r.judge_errors_total),
      cost_usd_total: Number(r.cost_usd_total),
      duration_ms: Number(r.duration_ms),
      source_tier_breakdown: r.source_tier_breakdown as Record<string, unknown>,
      report_json: r.report_json as Record<string, unknown>,
    }));
  }

  /** v0.32.6 P2 — cache lookup; returns verdict JSON or null. */
export async function getContradictionCacheEntry(deps: PgliteTakesDeps, key: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
  }): Promise<Record<string, unknown> | null> {
    const { rows } = await deps.db.query(
      `SELECT verdict FROM eval_contradictions_cache
       WHERE chunk_a_hash = $1
         AND chunk_b_hash = $2
         AND model_id = $3
         AND prompt_version = $4
         AND truncation_policy = $5
         AND expires_at > now()
       LIMIT 1`,
      [key.chunk_a_hash, key.chunk_b_hash, key.model_id, key.prompt_version, key.truncation_policy]
    );
    if (rows.length === 0) return null;
    return (rows[0] as Record<string, unknown>).verdict as Record<string, unknown>;
  }

  /** v0.32.6 P2 — cache upsert with TTL refresh on conflict. */
export async function putContradictionCacheEntry(deps: PgliteTakesDeps, opts: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
    verdict: Record<string, unknown>;
    ttl_seconds?: number;
  }): Promise<void> {
    const ttl = Math.max(60, opts.ttl_seconds ?? 30 * 86400);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await deps.db.query(
      `INSERT INTO eval_contradictions_cache (
         chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy,
         verdict, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy)
       DO UPDATE SET
         verdict = EXCLUDED.verdict,
         expires_at = EXCLUDED.expires_at,
         created_at = now()`,
      [
        opts.chunk_a_hash, opts.chunk_b_hash, opts.model_id,
        opts.prompt_version, opts.truncation_policy,
        opts.verdict, expiresAt,
      ]
    );
  }

  /** v0.32.6 P2 — periodic sweep of expired cache rows. */
export async function sweepContradictionCache(deps: PgliteTakesDeps): Promise<number> {
    const result = await deps.db.query(
      `DELETE FROM eval_contradictions_cache WHERE expires_at <= now()`
    );
    return result.affectedRows ?? 0;
  }

export async function listTakes(deps: PgliteTakesDeps, opts: TakesListOpts = {}): Promise<Take[]> {
    const limit = clampSearchLimit(opts.limit, 100, 500);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const active = opts.active ?? true;
    const sortBy = opts.sortBy ?? 'created_at';
    const { rows } = await deps.db.query(
      `SELECT t.*, p.slug AS page_slug
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE 1=1
         AND ($1::int   IS NULL OR t.page_id = $1::int)
         AND ($2::text  IS NULL OR p.slug    = $2::text)
         AND ($3::text  IS NULL OR t.holder  = $3::text)
         AND ($4::text  IS NULL OR t.kind    = $4::text)
         AND ($5::boolean IS NULL OR t.active = $5::boolean)
         AND (
           $6::boolean IS NULL
           OR ($6::boolean = true  AND t.resolved_at IS NOT NULL)
           OR ($6::boolean = false AND t.resolved_at IS NULL)
         )
         AND ($7::text[] IS NULL OR t.holder = ANY($7::text[]))
         AND ($11::text[] IS NULL OR p.source_id = ANY($11::text[]))
         AND ($12::text   IS NULL OR p.source_id = $12::text)
       ORDER BY
         CASE WHEN $8 = 'weight'      THEN t.weight     END DESC NULLS LAST,
         CASE WHEN $8 = 'since_date'  THEN t.since_date END DESC NULLS LAST,
         CASE WHEN $8 = 'created_at'  THEN t.created_at END DESC NULLS LAST
       LIMIT $9 OFFSET $10`,
      [
        opts.page_id ?? null,
        opts.page_slug ?? null,
        opts.holder ?? null,
        opts.kind ?? null,
        active,
        opts.resolved === undefined ? null : opts.resolved,
        opts.takesHoldersAllowList ?? null,
        sortBy,
        limit,
        offset,
        // #2200-class: source scope via the take's page.source_id (array wins over scalar).
        opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : null,
        opts.sourceIds && opts.sourceIds.length > 0 ? null : (opts.sourceId ?? null),
      ]
    );
    return rows.map((r) => takeRowToTake(r as Record<string, unknown>));
  }

export async function searchTakes(
  deps: PgliteTakesDeps,
    query: string,
    opts: SearchOpts & { takesHoldersAllowList?: string[] } = {},
  ): Promise<TakeHit[]> {
    const limit = clampSearchLimit(opts.limit, 30, 100);
    const { rows } = await deps.db.query(
      `SELECT t.id AS take_id, t.page_id, p.slug AS page_slug, t.row_num,
              t.claim, t.kind, t.holder, t.weight,
              word_similarity($1, t.claim)::real AS score
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE t.active
         AND $1 <% t.claim
         AND ($2::text[] IS NULL OR t.holder = ANY($2::text[]))
         AND ($4::text[] IS NULL OR p.source_id = ANY($4::text[]))
         AND ($5::text IS NULL OR p.source_id = $5::text)
       ORDER BY score DESC, t.weight DESC
       LIMIT $3`,
      [
        query,
        opts.takesHoldersAllowList ?? null,
        limit,
        opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : null,
        opts.sourceIds && opts.sourceIds.length > 0 ? null : (opts.sourceId ?? null),
      ]
    );
    // Engine parity with PostgresEngine: coerce hit rows through the shared
    // helper so both engines return the same TakeHit runtime shape (#2450).
    return rows.map((r) => takeHitRowToHit(r as Record<string, unknown>));
  }

export async function searchTakesVector(
  deps: PgliteTakesDeps,
    embedding: Float32Array,
    opts: SearchOpts & { takesHoldersAllowList?: string[] } = {},
  ): Promise<TakeHit[]> {
    const limit = clampSearchLimit(opts.limit, 30, 100);
    const vec = `[${Array.from(embedding).join(',')}]`;
    const { rows } = await deps.db.query(
      `SELECT t.id AS take_id, t.page_id, p.slug AS page_slug, t.row_num,
              t.claim, t.kind, t.holder, t.weight,
              (1 - (t.embedding <=> $1::vector))::real AS score
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE t.active
         AND t.embedding IS NOT NULL
         AND ($2::text[] IS NULL OR t.holder = ANY($2::text[]))
         AND ($4::text[] IS NULL OR p.source_id = ANY($4::text[]))
         AND ($5::text IS NULL OR p.source_id = $5::text)
       ORDER BY t.embedding <=> $1::vector
       LIMIT $3`,
      [
        vec,
        opts.takesHoldersAllowList ?? null,
        limit,
        opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : null,
        opts.sourceIds && opts.sourceIds.length > 0 ? null : (opts.sourceId ?? null),
      ]
    );
    // Engine parity with PostgresEngine: coerce hit rows through the shared
    // helper so both engines return the same TakeHit runtime shape (#2450).
    return rows.map((r) => takeHitRowToHit(r as Record<string, unknown>));
  }

export async function getTakeEmbeddings(deps: PgliteTakesDeps, ids: number[]): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    const { rows } = await deps.db.query(
      `SELECT id, embedding FROM takes WHERE id = ANY($1::bigint[]) AND embedding IS NOT NULL`,
      [ids]
    );
    const out = new Map<number, Float32Array>();
    for (const r of rows as Array<{ id: number; embedding: unknown }>) {
      const v = r.embedding;
      if (typeof v === 'string') {
        const trimmed = v.replace(/^\[|\]$/g, '');
        const arr = trimmed.split(',').map(parseFloat).filter(n => !Number.isNaN(n));
        out.set(Number(r.id), new Float32Array(arr));
      } else if (Array.isArray(v)) {
        out.set(Number(r.id), new Float32Array(v as number[]));
      }
    }
    return out;
  }

export async function countStaleTakes(deps: PgliteTakesDeps): Promise<number> {
    const { rows } = await deps.db.query(
      `SELECT count(*)::int AS count FROM takes WHERE active AND embedding IS NULL`
    );
    return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
  }

export async function listStaleTakes(deps: PgliteTakesDeps): Promise<StaleTakeRow[]> {
    const { rows } = await deps.db.query(
      `SELECT t.id AS take_id, p.slug AS page_slug, t.row_num, t.claim
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE t.active AND t.embedding IS NULL
       ORDER BY t.id
       LIMIT 100000`
    );
    return rows as unknown as StaleTakeRow[];
  }

export async function updateTake(
  deps: PgliteTakesDeps,
    pageId: number,
    rowNum: number,
    fields: { weight?: number; since_date?: string; source?: string },
  ): Promise<void> {
    let weight = fields.weight;
    if (weight !== undefined) {
      const norm = normalizeWeightForStorage(weight);
      if (norm.clamped) {
        process.stderr.write(`[takes] TAKES_WEIGHT_CLAMPED: updateTake clamped weight ${weight} → ${norm.weight}\n`);
      }
      weight = norm.weight;
    }
    const result = await deps.db.query(
      `UPDATE takes SET
         weight     = COALESCE($3::real, weight),
         since_date = COALESCE($4::text, since_date),
         source     = COALESCE($5::text, source),
         updated_at = now()
       WHERE page_id = $1 AND row_num = $2
       RETURNING 1`,
      [pageId, rowNum, weight ?? null, fields.since_date ?? null, fields.source ?? null]
    );
    if (result.rows.length === 0) {
      throw new GBrainError(
        'TAKE_ROW_NOT_FOUND',
        `take not found at page_id=${pageId} row=${rowNum}`,
        'list takes for this page with `gbrain takes <slug>` to see valid row numbers',
      );
    }
  }

export async function supersedeTake(
  deps: PgliteTakesDeps,
    pageId: number,
    oldRow: number,
    newRow: Omit<TakeBatchInput, 'page_id' | 'row_num' | 'superseded_by'>,
  ): Promise<{ oldRow: number; newRow: number }> {
    return await deps.db.transaction(async (tx) => {
      const existingRes = await tx.query(
        `SELECT resolved_at FROM takes WHERE page_id = $1 AND row_num = $2`,
        [pageId, oldRow]
      );
      const existing = existingRes.rows[0] as { resolved_at?: unknown } | undefined;
      if (!existing) {
        throw new GBrainError('TAKE_ROW_NOT_FOUND', `take not found at page_id=${pageId} row=${oldRow}`, 'list takes with `gbrain takes <slug>`');
      }
      if (existing.resolved_at) {
        throw new GBrainError('TAKE_RESOLVED_IMMUTABLE', `take ${pageId}#${oldRow} is resolved`, 'resolved bets are immutable; add a new take instead');
      }
      const maxRowRes = await tx.query(
        `SELECT COALESCE(MAX(row_num), 0) + 1 AS next FROM takes WHERE page_id = $1`,
        [pageId]
      );
      const newRowNum = Number((maxRowRes.rows[0] as { next?: number })?.next ?? 1);
      const w = Math.max(0, Math.min(1, newRow.weight ?? 0.5));
      await tx.query(
        `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, until_date, source, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text, $8::text, $9, $10)`,
        [
          pageId, newRowNum, newRow.claim, newRow.kind, newRow.holder, w,
          newRow.since_date ?? null, newRow.until_date ?? null, newRow.source ?? null,
          newRow.active ?? true,
        ]
      );
      await tx.query(
        `UPDATE takes SET active = false, superseded_by = $3, updated_at = now()
         WHERE page_id = $1 AND row_num = $2`,
        [pageId, oldRow, newRowNum]
      );
      return { oldRow, newRow: newRowNum };
    });
  }

export async function resolveTake(deps: PgliteTakesDeps, pageId: number, rowNum: number, resolution: TakeResolution): Promise<void> {
    const existingRes = await deps.db.query(
      `SELECT resolved_at FROM takes WHERE page_id = $1 AND row_num = $2`,
      [pageId, rowNum]
    );
    const existing = existingRes.rows[0] as { resolved_at?: unknown } | undefined;
    if (!existing) {
      throw new GBrainError('TAKE_ROW_NOT_FOUND', `take not found at page_id=${pageId} row=${rowNum}`, 'list takes with `gbrain takes <slug>`');
    }
    if (existing.resolved_at) {
      throw new GBrainError('TAKE_ALREADY_RESOLVED', `take ${pageId}#${rowNum} already resolved`, 'resolution is immutable; add a new take to record a new outcome');
    }
    // v0.30.0: derive (quality, outcome) tuple. quality wins when both set.
    const { quality, outcome } = deriveResolutionTuple(resolution);
    await deps.db.query(
      `UPDATE takes SET
         resolved_at      = now(),
         resolved_quality = $3::text,
         resolved_outcome = $4,
         resolved_value   = $5::real,
         resolved_unit    = $6::text,
         resolved_source  = $7::text,
         resolved_by      = $8,
         updated_at       = now()
       WHERE page_id = $1 AND row_num = $2`,
      [
        pageId, rowNum,
        quality,
        outcome,
        resolution.value ?? null,
        resolution.unit ?? null,
        resolution.source ?? null,
        resolution.resolvedBy,
      ]
    );
  }

  /**
   * v0.30.0: aggregate scorecard. SQL-level allow-list filter (D4 fail-closed).
   * Hidden-holder rows contribute zero to aggregates.
   */
export async function getScorecard(deps: PgliteTakesDeps, opts: TakesScorecardOpts, allowList: string[] | undefined): Promise<TakesScorecard> {
    // Build the WHERE clause with positional params. PGLite (postgres-via-WASM)
    // shares the SQL dialect with real Postgres so the math expressions match.
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (opts.holder !== undefined) { params.push(opts.holder); clauses.push(`AND holder = $${params.length}`); }
    if (opts.domainPrefix !== undefined) {
      params.push(opts.domainPrefix + '%');
      clauses.push(`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.slug LIKE $${params.length})`);
    }
    if (opts.since !== undefined) { params.push(opts.since); clauses.push(`AND since_date >= $${params.length}`); }
    if (opts.until !== undefined) { params.push(opts.until); clauses.push(`AND since_date <= $${params.length}`); }
    if (allowList !== undefined) { params.push(allowList); clauses.push(`AND holder = ANY($${params.length}::text[])`); }
    // #2200-class: source scope via the take's page (EXISTS — no pages JOIN here).
    const srcIds = opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : null;
    if (srcIds) { params.push(srcIds); clauses.push(`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.source_id = ANY($${params.length}::text[]))`); }
    else if (opts.sourceId) { params.push(opts.sourceId); clauses.push(`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.source_id = $${params.length})`); }
    const where = clauses.join(' ');
    // v0.36.1.1 T1c: `resolved` deliberately filters to the 3-state subset
    // (correct|incorrect|partial) — NOT `resolved_quality IS NOT NULL` — so
    // historical comparisons against pre-v74 scorecards stay valid.
    // `unresolvable_count` is a sibling field counting the new 4th state.
    const res = await deps.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE kind = 'bet')::int                                              AS total_bets,
         COUNT(*) FILTER (WHERE resolved_quality IN ('correct','incorrect','partial'))::int     AS resolved,
         COUNT(*) FILTER (WHERE resolved_quality = 'correct')::int                              AS correct,
         COUNT(*) FILTER (WHERE resolved_quality = 'incorrect')::int                            AS incorrect,
         COUNT(*) FILTER (WHERE resolved_quality = 'partial')::int                              AS partial,
         COUNT(*) FILTER (WHERE resolved_quality = 'unresolvable')::int                         AS unresolvable_count,
         AVG(
           CASE WHEN resolved_quality IN ('correct','incorrect')
                THEN POWER(weight - (CASE resolved_quality WHEN 'correct' THEN 1 ELSE 0 END), 2)
           END
         )::float                                                                               AS brier
       FROM takes
       WHERE 1=1 ${where}`,
      params,
    );
    const r = res.rows[0] as { total_bets: number; resolved: number; correct: number; incorrect: number; partial: number; unresolvable_count: number; brier: number | null };
    return finalizeScorecard(r);
  }

  /**
   * v0.30.0: calibration curve. Bins resolved correct/incorrect bets by stated weight.
   */
export async function getCalibrationCurve(deps: PgliteTakesDeps, opts: CalibrationCurveOpts, allowList: string[] | undefined): Promise<CalibrationBucket[]> {
    const bucketSize = opts.bucketSize && opts.bucketSize > 0 && opts.bucketSize <= 1 ? opts.bucketSize : 0.1;
    const maxIdx = Math.floor(1 / bucketSize) - 1;
    const params: unknown[] = [bucketSize, maxIdx];
    const clauses: string[] = [];
    if (opts.holder !== undefined) { params.push(opts.holder); clauses.push(`AND holder = $${params.length}`); }
    if (allowList !== undefined) { params.push(allowList); clauses.push(`AND holder = ANY($${params.length}::text[])`); }
    // #2200-class: source scope via the take's page (EXISTS — no pages JOIN here).
    const srcIds = opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : null;
    if (srcIds) { params.push(srcIds); clauses.push(`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.source_id = ANY($${params.length}::text[]))`); }
    else if (opts.sourceId) { params.push(opts.sourceId); clauses.push(`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.source_id = $${params.length})`); }
    const where = clauses.join(' ');
    // NUMERIC casts for exact decimal arithmetic — keeps PGLite + Postgres
    // bucket boundaries identical at FP-edge weights (e.g. 0.7/0.1).
    // See parity test in test/e2e/takes-scorecard-parity.test.ts.
    const res = await deps.db.query(
      `WITH binned AS (
         SELECT
           LEAST(FLOOR(weight::numeric / $1::numeric)::int, $2::int)::int AS bucket_idx,
           weight,
           (resolved_quality = 'correct')::int            AS hit
         FROM takes
         WHERE resolved_quality IN ('correct','incorrect')
           ${where}
       )
       SELECT
         (bucket_idx::numeric * $1::numeric)::float        AS bucket_lo,
         ((bucket_idx + 1)::numeric * $1::numeric)::float  AS bucket_hi,
         COUNT(*)::int                                     AS n,
         AVG(hit)::float                                   AS observed,
         AVG(weight)::float                                AS predicted
       FROM binned
       GROUP BY bucket_idx
       ORDER BY bucket_idx`,
      params,
    );
    return (res.rows as { bucket_lo: number; bucket_hi: number; n: number; observed: number | null; predicted: number | null }[]).map(r => ({
      bucket_lo: r.bucket_lo,
      bucket_hi: r.bucket_hi,
      n: r.n,
      observed: r.n > 0 ? r.observed : null,
      predicted: r.n > 0 ? r.predicted : null,
    }));
  }

export async function addSynthesisEvidence(deps: PgliteTakesDeps, rowsIn: SynthesisEvidenceInput[]): Promise<number> {
    if (rowsIn.length === 0) return 0;
    const synthesisIds = rowsIn.map(r => r.synthesis_page_id);
    const takePageIds  = rowsIn.map(r => r.take_page_id);
    const takeRowNums  = rowsIn.map(r => r.take_row_num);
    const citationIxs  = rowsIn.map(r => r.citation_index);
    const result = await deps.db.query(
      `INSERT INTO synthesis_evidence (synthesis_page_id, take_page_id, take_row_num, citation_index)
       SELECT v.synthesis_page_id::int, v.take_page_id::int, v.take_row_num::int, v.citation_index::int
       FROM unnest($1::int[], $2::int[], $3::int[], $4::int[])
         AS v(synthesis_page_id, take_page_id, take_row_num, citation_index)
       ON CONFLICT (synthesis_page_id, take_page_id, take_row_num) DO NOTHING
       RETURNING 1`,
      [synthesisIds, takePageIds, takeRowNums, citationIxs]
    );
    return result.rows.length;
  }
