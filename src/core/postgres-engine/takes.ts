/**
 * v0.28: Takes (typed/weighted/attributed claims) + synthesis_evidence,
 * peeled out of PostgresEngine (containment sprint C15). Free functions over
 * a NARROW deps surface — never the whole engine class.
 */
import type postgres from 'postgres';

type PgSql = ReturnType<typeof postgres>;

import type {
  BatchOpts,
  TakeBatchInput, Take, TakesListOpts, TakeHit, StaleTakeRow,
  TakeEmbeddingInput,
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
import { staleTakeRowToRow, takeRowToTake, takeHitRowToHit, tryParseEmbedding } from '../utils.ts';

/** Narrow slice of PostgresEngine the takes operations use. */
export interface PgTakesDeps {
  /** Live postgres.js pool (getter-backed at the call site). */
  readonly sql: PgSql;
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

export async function addTakesBatch(deps: PgTakesDeps, rowsIn: TakeBatchInput[], opts?: BatchOpts): Promise<number> {
    if (rowsIn.length === 0) return 0;
    // v0.42.26: takes is a batch primitive too — wrap in batchRetry so a
    // Supavisor circuit-breaker blip doesn't silently drop takes the way it
    // could before (links/timeline already had this; takes was the gap).
    return deps.batchRetry(opts?.auditSite ?? 'addTakesBatch', opts?.signal, () => _addTakesBatchOnce(deps, rowsIn), rowsIn.length);
  }

async function _addTakesBatchOnce(deps: PgTakesDeps, rowsIn: TakeBatchInput[]): Promise<number> {
    // #1861: JSONB jsonb_to_recordset instead of unnest(${arr}::text[]). `claim`
    // is free LLM-extracted prose with the same array-literal crash hazard as
    // link context. JSONB additionally lets us declare NATIVE recordset column
    // types and emit JSON-native numbers/booleans, which retires the old
    // postgres-js ${actives}::text[]::boolean[] element-type workaround entirely.
    // Weight clamp/round + NUL-stripping live in buildTakeRows (shared w/ PGLite).
    // NOTE: ON CONFLICT here is DO UPDATE (not DO NOTHING) — an intra-batch
    // duplicate (page_id, row_num) errors, identical to the pre-#1861 unnest path.
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

  /**
   * v0.32.6 — batched per-page active-takes fetch (P1). One round-trip
   * regardless of how many pages the caller passes. Honors holder allow-list
   * for MCP scope enforcement. Pages with no active takes get an empty array.
   */
export async function listActiveTakesForPages(
  deps: PgTakesDeps,
    pageIds: number[],
    opts: { takesHoldersAllowList?: string[] } = {},
  ): Promise<Map<number, Take[]>> {
    const out = new Map<number, Take[]>();
    for (const pid of pageIds) out.set(pid, []);
    if (pageIds.length === 0) return out;
    const sql = deps.sql;
    const rows = await sql`
      SELECT t.*, p.slug AS page_slug
      FROM takes t
      JOIN pages p ON p.id = t.page_id
      WHERE t.page_id = ANY(${pageIds}::int[])
        AND t.active = true
        AND (
          ${opts.takesHoldersAllowList ?? null}::text[] IS NULL
          OR t.holder = ANY(${opts.takesHoldersAllowList ?? null}::text[])
        )
      ORDER BY t.page_id, t.row_num
    `;
    for (const r of rows) {
      const take = takeRowToTake(r as Record<string, unknown>);
      const bucket = out.get(take.page_id);
      if (bucket) bucket.push(take);
    }
    return out;
  }

  /**
   * v0.32.6 — persist a contradiction-probe run row (M5). Idempotent on
   * run_id via ON CONFLICT DO NOTHING. Returns true iff a row was inserted.
   */
export async function writeContradictionsRun(deps: PgTakesDeps, row: {
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
    const sql = deps.sql;
    const result = await sql`
      INSERT INTO eval_contradictions_runs (
        run_id, judge_model, prompt_version,
        queries_evaluated, queries_with_contradiction, total_contradictions_flagged,
        wilson_ci_lower, wilson_ci_upper, judge_errors_total,
        cost_usd_total, duration_ms,
        source_tier_breakdown, report_json
      ) VALUES (
        ${row.run_id}, ${row.judge_model}, ${row.prompt_version},
        ${row.queries_evaluated}, ${row.queries_with_contradiction}, ${row.total_contradictions_flagged},
        ${row.wilson_ci_lower}, ${row.wilson_ci_upper}, ${row.judge_errors_total},
        ${row.cost_usd_total}, ${row.duration_ms},
        ${sql.json(row.source_tier_breakdown as Parameters<typeof sql.json>[0])},
        ${sql.json(row.report_json as Parameters<typeof sql.json>[0])}
      )
      ON CONFLICT (run_id) DO NOTHING
    `;
    return result.count > 0;
  }

  /**
   * v0.32.6 — load probe runs from the last N days, newest first (M5).
   * Used by `trend` sub-subcommand and the doctor `contradictions` check.
   */
export async function loadContradictionsTrend(deps: PgTakesDeps, days: number): Promise<Array<{
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
    const sql = deps.sql;
    const cutoff = new Date(Date.now() - Math.max(0, days) * 86400000);
    const rows = await sql`
      SELECT run_id, ran_at, judge_model,
             queries_evaluated, queries_with_contradiction, total_contradictions_flagged,
             wilson_ci_lower, wilson_ci_upper, judge_errors_total,
             cost_usd_total, duration_ms,
             source_tier_breakdown, report_json
      FROM eval_contradictions_runs
      WHERE ran_at >= ${cutoff}
      ORDER BY ran_at DESC
    `;
    return rows.map((r) => ({
      run_id: r.run_id as string,
      ran_at: (r.ran_at instanceof Date ? r.ran_at.toISOString() : String(r.ran_at)),
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

  /**
   * v0.32.6 — judge cache lookup (P2). Returns verdict JSON for a non-
   * expired row matching the full 5-component key, else NULL.
   */
export async function getContradictionCacheEntry(deps: PgTakesDeps, key: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
  }): Promise<Record<string, unknown> | null> {
    const sql = deps.sql;
    const rows = await sql`
      SELECT verdict
      FROM eval_contradictions_cache
      WHERE chunk_a_hash = ${key.chunk_a_hash}
        AND chunk_b_hash = ${key.chunk_b_hash}
        AND model_id = ${key.model_id}
        AND prompt_version = ${key.prompt_version}
        AND truncation_policy = ${key.truncation_policy}
        AND expires_at > now()
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rows[0].verdict as Record<string, unknown>;
  }

  /**
   * v0.32.6 — judge cache upsert. ON CONFLICT DO UPDATE refreshes verdict +
   * slides expires_at forward; same-key re-runs are safe.
   */
export async function putContradictionCacheEntry(deps: PgTakesDeps, opts: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
    verdict: Record<string, unknown>;
    ttl_seconds?: number;
  }): Promise<void> {
    const sql = deps.sql;
    const ttl = Math.max(60, opts.ttl_seconds ?? 30 * 86400);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await sql`
      INSERT INTO eval_contradictions_cache (
        chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy,
        verdict, expires_at
      ) VALUES (
        ${opts.chunk_a_hash}, ${opts.chunk_b_hash}, ${opts.model_id},
        ${opts.prompt_version}, ${opts.truncation_policy},
        ${sql.json(opts.verdict as Parameters<typeof sql.json>[0])}, ${expiresAt}
      )
      ON CONFLICT (chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy)
      DO UPDATE SET
        verdict = EXCLUDED.verdict,
        expires_at = EXCLUDED.expires_at,
        created_at = now()
    `;
  }

  /** v0.32.6 — periodic sweep of expired cache rows. */
export async function sweepContradictionCache(deps: PgTakesDeps): Promise<number> {
    const sql = deps.sql;
    const result = await sql`
      DELETE FROM eval_contradictions_cache WHERE expires_at <= now()
    `;
    return result.count ?? 0;
  }

export async function listTakes(deps: PgTakesDeps, opts: TakesListOpts = {}): Promise<Take[]> {
    const sql = deps.sql;
    const limit = clampSearchLimit(opts.limit, 100, 500);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const active = opts.active ?? true;
    // #2200-class: takes have no source_id of their own; scope via the page's
    // source_id (already JOINed). Array wins over scalar, matching sourceScopeOpts.
    const sourceFilter =
      opts.sourceIds && opts.sourceIds.length > 0
        ? sql`AND p.source_id = ANY(${opts.sourceIds}::text[])`
        : opts.sourceId
          ? sql`AND p.source_id = ${opts.sourceId}`
          : sql``;
    const rows = await sql`
      SELECT t.*, p.slug AS page_slug
      FROM takes t
      JOIN pages p ON p.id = t.page_id
      WHERE 1=1
        AND (${opts.page_id ?? null}::int   IS NULL OR t.page_id = ${opts.page_id ?? null}::int)
        AND (${opts.page_slug ?? null}::text IS NULL OR p.slug   = ${opts.page_slug ?? null}::text)
        AND (${opts.holder ?? null}::text   IS NULL OR t.holder  = ${opts.holder ?? null}::text)
        AND (${opts.kind ?? null}::text     IS NULL OR t.kind    = ${opts.kind ?? null}::text)
        AND (${active}::boolean IS NULL OR t.active = ${active}::boolean)
        AND (
          ${opts.resolved === undefined ? null : opts.resolved}::boolean IS NULL
          OR (${opts.resolved === undefined ? null : opts.resolved}::boolean = true  AND t.resolved_at IS NOT NULL)
          OR (${opts.resolved === undefined ? null : opts.resolved}::boolean = false AND t.resolved_at IS NULL)
        )
        AND (
          ${opts.takesHoldersAllowList ?? null}::text[] IS NULL
          OR t.holder = ANY(${opts.takesHoldersAllowList ?? null}::text[])
        )
        ${sourceFilter}
      ORDER BY
        CASE WHEN ${opts.sortBy ?? 'created_at'} = 'weight'      THEN t.weight     END DESC NULLS LAST,
        CASE WHEN ${opts.sortBy ?? 'created_at'} = 'since_date'  THEN t.since_date END DESC NULLS LAST,
        CASE WHEN ${opts.sortBy ?? 'created_at'} = 'created_at'  THEN t.created_at END DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map((r) => takeRowToTake(r as Record<string, unknown>));
  }

export async function searchTakes(deps: PgTakesDeps, query: string, opts: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[] } = {}): Promise<TakeHit[]> {
    const sql = deps.sql;
    const limit = clampSearchLimit(opts.limit, 30, 100);
    const sourceFilter = opts.sourceIds && opts.sourceIds.length > 0
      ? sql`AND p.source_id = ANY(${opts.sourceIds}::text[])`
      : opts.sourceId
        ? sql`AND p.source_id = ${opts.sourceId}`
        : sql``;
    const rows = await sql`
      SELECT t.id AS take_id, t.page_id, p.slug AS page_slug, t.row_num,
             t.claim, t.kind, t.holder, t.weight,
             word_similarity(${query}, t.claim)::real AS score
      FROM takes t
      JOIN pages p ON p.id = t.page_id
      WHERE t.active
        AND ${query} <% t.claim
        AND (
          ${opts.takesHoldersAllowList ?? null}::text[] IS NULL
          OR t.holder = ANY(${opts.takesHoldersAllowList ?? null}::text[])
        )
        ${sourceFilter}
      ORDER BY score DESC, t.weight DESC
      LIMIT ${limit}
    `;
    // #2450-class: int8 columns arrive as native BigInt from the pg driver;
    // coerce per-row (takeRowToTake precedent) so MCP/CLI JSON.stringify
    // doesn't crash the moment a search actually matches.
    return rows.map((r) => takeHitRowToHit(r as Record<string, unknown>));
  }

export async function searchTakesVector(
  deps: PgTakesDeps,
    embedding: Float32Array,
    opts: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[] } = {},
  ): Promise<TakeHit[]> {
    const sql = deps.sql;
    const limit = clampSearchLimit(opts.limit, 30, 100);
    const vec = `[${Array.from(embedding).join(',')}]`;
    const sourceFilter = opts.sourceIds && opts.sourceIds.length > 0
      ? sql`AND p.source_id = ANY(${opts.sourceIds}::text[])`
      : opts.sourceId
        ? sql`AND p.source_id = ${opts.sourceId}`
        : sql``;
    const rows = await sql`
      SELECT t.id AS take_id, t.page_id, p.slug AS page_slug, t.row_num,
             t.claim, t.kind, t.holder, t.weight,
             (1 - (t.embedding <=> ${vec}::vector))::real AS score
      FROM takes t
      JOIN pages p ON p.id = t.page_id
      WHERE t.active
        AND t.embedding IS NOT NULL
        AND (
          ${opts.takesHoldersAllowList ?? null}::text[] IS NULL
          OR t.holder = ANY(${opts.takesHoldersAllowList ?? null}::text[])
        )
        ${sourceFilter}
      ORDER BY t.embedding <=> ${vec}::vector
      LIMIT ${limit}
    `;
    // #2450-class: int8 columns arrive as native BigInt from the pg driver;
    // coerce per-row (takeRowToTake precedent) so MCP/CLI JSON.stringify
    // doesn't crash the moment a search actually matches.
    return rows.map((r) => takeHitRowToHit(r as Record<string, unknown>));
  }

export async function getTakeEmbeddings(deps: PgTakesDeps, ids: number[]): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    const sql = deps.sql;
    const rows = await sql`
      SELECT id, embedding FROM takes WHERE id = ANY(${ids}::bigint[]) AND embedding IS NOT NULL
    `;
    const out = new Map<number, Float32Array>();
    for (const r of rows as unknown as Array<{ id: number; embedding: unknown }>) {
      const parsed = tryParseEmbedding(r.embedding);
      if (parsed) out.set(Number(r.id), parsed);
    }
    return out;
  }

export async function countStaleTakes(deps: PgTakesDeps): Promise<number> {
    const sql = deps.sql;
    const [row] = await sql`
      SELECT count(*)::int AS count FROM takes WHERE active AND embedding IS NULL
    `;
    return Number((row as { count?: number } | undefined)?.count ?? 0);
  }

export async function listStaleTakes(deps: PgTakesDeps): Promise<StaleTakeRow[]> {
    const sql = deps.sql;
    const rows = await sql`
      SELECT t.id AS take_id, p.slug AS page_slug, t.row_num, t.claim
      FROM takes t
      JOIN pages p ON p.id = t.page_id
      WHERE t.active AND t.embedding IS NULL
      ORDER BY t.id
      LIMIT 100000
    `;
    return rows.map((row) => staleTakeRowToRow(row as Record<string, unknown>));
  }

export async function updateTakeEmbeddings(
  deps: PgTakesDeps,
  rowsIn: TakeEmbeddingInput[],
  opts?: BatchOpts,
): Promise<number> {
  if (rowsIn.length === 0) return 0;
  return deps.batchRetry(
    opts?.auditSite ?? 'updateTakeEmbeddings',
    opts?.signal,
    () => _updateTakeEmbeddingsOnce(deps, rowsIn),
    rowsIn.length,
  );
}

async function _updateTakeEmbeddingsOnce(
  deps: PgTakesDeps,
  rowsIn: TakeEmbeddingInput[],
): Promise<number> {
  const seen = new Set<number>();
  const rows = rowsIn.map(({ take_id, embedding }) => {
    if (!Number.isInteger(take_id) || take_id <= 0) throw new Error(`invalid take_id: ${take_id}`);
    if (seen.has(take_id)) throw new Error(`duplicate take_id in embedding batch: ${take_id}`);
    seen.add(take_id);
    const values = Array.from(embedding);
    if (values.length === 0 || values.some(v => !Number.isFinite(v))) {
      throw new Error(`invalid embedding for take_id=${take_id}`);
    }
    return { take_id, embedding: `[${values.join(',')}]` };
  });
  const result = await deps.executeRawJsonb(
    `WITH updated AS (
       UPDATE takes AS t
          SET embedding = v.embedding::vector,
              embedded_at = now(),
              updated_at = now()
         FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(take_id bigint, embedding text)
        WHERE t.id = v.take_id AND t.active
        RETURNING t.id
     )
     SELECT id FROM updated`,
    [],
    [{ rows }],
  );
  return result.length;
}

export async function updateTake(
  deps: PgTakesDeps,
    pageId: number,
    rowNum: number,
    fields: { weight?: number; since_date?: string; source?: string },
  ): Promise<void> {
    const sql = deps.sql;
    let weight = fields.weight;
    if (weight !== undefined) {
      const norm = normalizeWeightForStorage(weight);
      if (norm.clamped) {
        process.stderr.write(`[takes] TAKES_WEIGHT_CLAMPED: updateTake clamped weight ${weight} → ${norm.weight}\n`);
      }
      weight = norm.weight;
    }
    const result = await sql`
      UPDATE takes SET
        weight     = COALESCE(${weight ?? null}::real, weight),
        since_date = COALESCE(${fields.since_date ?? null}::text, since_date),
        source     = COALESCE(${fields.source ?? null}::text, source),
        updated_at = now()
      WHERE page_id = ${pageId} AND row_num = ${rowNum}
      RETURNING 1
    `;
    if (result.length === 0) {
      throw new GBrainError('TAKE_ROW_NOT_FOUND', `take not found at page_id=${pageId} row=${rowNum}`, 'list takes for this page with `gbrain takes <slug>` to see valid row numbers');
    }
  }

export async function supersedeTake(
  deps: PgTakesDeps,
    pageId: number,
    oldRow: number,
    newRow: Omit<TakeBatchInput, 'page_id' | 'row_num' | 'superseded_by'>,
  ): Promise<{ oldRow: number; newRow: number }> {
    const conn = deps.sql;
    return await conn.begin(async (tx) => {
      const [existing] = await tx`
        SELECT resolved_at FROM takes WHERE page_id = ${pageId} AND row_num = ${oldRow}
      `;
      if (!existing) throw new GBrainError('TAKE_ROW_NOT_FOUND', `take not found at page_id=${pageId} row=${oldRow}`, 'list takes with `gbrain takes <slug>`');
      if ((existing as { resolved_at?: unknown }).resolved_at) {
        throw new GBrainError('TAKE_RESOLVED_IMMUTABLE', `take ${pageId}#${oldRow} is resolved`, 'resolved bets are immutable; add a new take instead');
      }
      const [maxRow] = await tx`SELECT COALESCE(MAX(row_num), 0) + 1 AS next FROM takes WHERE page_id = ${pageId}`;
      const newRowNum = Number((maxRow as { next?: number })?.next ?? 1);
      const wClamped = Math.max(0, Math.min(1, newRow.weight ?? 0.5));
      await tx`
        INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, until_date, source, active)
        VALUES (${pageId}, ${newRowNum}, ${newRow.claim}, ${newRow.kind}, ${newRow.holder}, ${wClamped},
                ${newRow.since_date ?? null}::text, ${newRow.until_date ?? null}::text,
                ${newRow.source ?? null}, ${newRow.active ?? true})
      `;
      await tx`
        UPDATE takes SET active = false, superseded_by = ${newRowNum}, updated_at = now()
        WHERE page_id = ${pageId} AND row_num = ${oldRow}
      `;
      return { oldRow, newRow: newRowNum };
    }) as { oldRow: number; newRow: number };
  }

export async function resolveTake(deps: PgTakesDeps, pageId: number, rowNum: number, resolution: TakeResolution): Promise<void> {
    const sql = deps.sql;
    const [existing] = await sql`SELECT resolved_at FROM takes WHERE page_id = ${pageId} AND row_num = ${rowNum}`;
    if (!existing) throw new GBrainError('TAKE_ROW_NOT_FOUND', `take not found at page_id=${pageId} row=${rowNum}`, 'list takes for this page with `gbrain takes <slug>` to see valid row numbers');
    if ((existing as { resolved_at?: unknown }).resolved_at) {
      throw new GBrainError('TAKE_ALREADY_RESOLVED', `take ${pageId}#${rowNum} already resolved`, 'resolution is immutable; add a new take to record a new outcome');
    }
    // v0.30.0: derive (quality, outcome) tuple. quality wins when both set.
    // Schema CHECK enforces consistency as a defense-in-depth backstop.
    const { quality, outcome } = deriveResolutionTuple(resolution);
    await sql`
      UPDATE takes SET
        resolved_at      = now(),
        resolved_quality = ${quality}::text,
        resolved_outcome = ${outcome},
        resolved_value   = ${resolution.value ?? null}::real,
        resolved_unit    = ${resolution.unit ?? null}::text,
        resolved_source  = ${resolution.source ?? null}::text,
        resolved_by      = ${resolution.resolvedBy},
        updated_at       = now()
      WHERE page_id = ${pageId} AND row_num = ${rowNum}
    `;
  }

  /**
   * v0.30.0: aggregate scorecard. SQL-level allow-list filter (D4 fail-closed).
   * Hidden-holder rows contribute zero to aggregates. NULL allowList means
   * trusted caller (no filtering). Empty array → zero results.
   */
export async function getScorecard(deps: PgTakesDeps, opts: TakesScorecardOpts, allowList: string[] | undefined): Promise<TakesScorecard> {
    const sql = deps.sql;
    const allowed = allowList ? sql`AND holder = ANY(${allowList}::text[])` : sql``;
    const holderClause = opts.holder ? sql`AND holder = ${opts.holder}` : sql``;
    const domainClause = opts.domainPrefix
      ? sql`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.slug LIKE ${opts.domainPrefix + '%'})`
      : sql``;
    const sinceClause = opts.since ? sql`AND since_date >= ${opts.since}` : sql``;
    const untilClause = opts.until ? sql`AND since_date <= ${opts.until}` : sql``;
    // #2200-class: takes carry no source_id; scope via the take's page via EXISTS
    // (this query has no pages JOIN). Array wins over scalar (sourceScopeOpts shape).
    const sourceFilter =
      opts.sourceIds && opts.sourceIds.length > 0
        ? sql`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.source_id = ANY(${opts.sourceIds}::text[]))`
        : opts.sourceId
          ? sql`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.source_id = ${opts.sourceId})`
          : sql``;
    // v0.36.1.1 T1c: `resolved` deliberately filters to the 3-state subset
    // (correct|incorrect|partial) — NOT `resolved_quality IS NOT NULL` — so
    // historical comparisons against pre-v74 scorecards stay valid.
    // `unresolvable_count` is a sibling field counting the new 4th state.
    const rows = await sql`
      SELECT
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
      WHERE 1=1 ${holderClause} ${domainClause} ${sinceClause} ${untilClause} ${allowed} ${sourceFilter}
    `;
    const r = rows[0] as { total_bets: number; resolved: number; correct: number; incorrect: number; partial: number; unresolvable_count: number; brier: number | null };
    return finalizeScorecard(r);
  }

  /**
   * v0.30.0: calibration curve. Bins resolved correct/incorrect bets by stated
   * weight. Same allow-list contract as getScorecard.
   *
   * Real-Postgres-via-postgres.js sends scalar params as text by default, so
   * `${bucketSize}` arrives as the string `'0.1'`. Without explicit `::float`
   * casts the FLOOR/LEAST/multiplication contexts try to coerce text to int
   * and bomb with `invalid input syntax for type integer: "0.1"`. PGLite is
   * more permissive — caught at e2e parity by takes-scorecard-parity.test.ts.
   */
export async function getCalibrationCurve(deps: PgTakesDeps, opts: CalibrationCurveOpts, allowList: string[] | undefined): Promise<CalibrationBucket[]> {
    const sql = deps.sql;
    const bucketSize = opts.bucketSize && opts.bucketSize > 0 && opts.bucketSize <= 1 ? opts.bucketSize : 0.1;
    const maxIdx = Math.floor(1 / bucketSize) - 1;
    const allowed = allowList ? sql`AND holder = ANY(${allowList}::text[])` : sql``;
    const holderClause = opts.holder ? sql`AND holder = ${opts.holder}` : sql``;
    const sourceFilter =
      opts.sourceIds && opts.sourceIds.length > 0
        ? sql`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.source_id = ANY(${opts.sourceIds}::text[]))`
        : opts.sourceId
          ? sql`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.source_id = ${opts.sourceId})`
          : sql``;
    // Bucketing uses NUMERIC for exact decimal arithmetic. Going through
    // FLOAT introduces IEEE 754 rounding (e.g. 0.7/0.1 = 6.9999..., FLOOR=6
    // instead of the expected 7), which makes Postgres and PGLite diverge
    // at bucket boundaries. NUMERIC is exact, so the bucket index is
    // engine-agnostic and the parity test holds.
    const rows = await sql`
      WITH binned AS (
        SELECT
          LEAST(FLOOR(weight::numeric / ${bucketSize}::numeric)::int, ${maxIdx}::int)::int AS bucket_idx,
          weight,
          (resolved_quality = 'correct')::int AS hit
        FROM takes
        WHERE resolved_quality IN ('correct','incorrect')
          ${holderClause} ${allowed} ${sourceFilter}
      )
      SELECT
        (bucket_idx::numeric * ${bucketSize}::numeric)::float       AS bucket_lo,
        ((bucket_idx + 1)::numeric * ${bucketSize}::numeric)::float AS bucket_hi,
        COUNT(*)::int                                                AS n,
        AVG(hit)::float                                              AS observed,
        AVG(weight)::float                                           AS predicted
      FROM binned
      GROUP BY bucket_idx
      ORDER BY bucket_idx
    `;
    return (rows as unknown as { bucket_lo: number; bucket_hi: number; n: number; observed: number | null; predicted: number | null }[]).map(r => ({
      bucket_lo: r.bucket_lo,
      bucket_hi: r.bucket_hi,
      n: r.n,
      observed: r.n > 0 ? r.observed : null,
      predicted: r.n > 0 ? r.predicted : null,
    }));
  }

export async function addSynthesisEvidence(deps: PgTakesDeps, rowsIn: SynthesisEvidenceInput[]): Promise<number> {
    if (rowsIn.length === 0) return 0;
    const sql = deps.sql;
    const synthesisIds = rowsIn.map(r => r.synthesis_page_id);
    const takePageIds  = rowsIn.map(r => r.take_page_id);
    const takeRowNums  = rowsIn.map(r => r.take_row_num);
    const citationIxs  = rowsIn.map(r => r.citation_index);
    const result = await sql`
      INSERT INTO synthesis_evidence (synthesis_page_id, take_page_id, take_row_num, citation_index)
      SELECT v.synthesis_page_id::int, v.take_page_id::int, v.take_row_num::int, v.citation_index::int
      FROM unnest(
        ${synthesisIds}::int[], ${takePageIds}::int[], ${takeRowNums}::int[], ${citationIxs}::int[]
      ) AS v(synthesis_page_id, take_page_id, take_row_num, citation_index)
      ON CONFLICT (synthesis_page_id, take_page_id, take_row_num) DO NOTHING
      RETURNING 1
    `;
    return result.length;
  }
