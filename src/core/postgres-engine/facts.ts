/**
 * v0.31: Hot memory — facts table operations, peeled out of PostgresEngine
 * (containment sprint C15). Free functions over a NARROW deps surface — the
 * live postgres.js pool + the engine's cached facts.embedding cast probe.
 * Never the whole engine class.
 */
import type postgres from 'postgres';

type PgSql = ReturnType<typeof postgres>;

import type {
  FactRow, FactKind, FactVisibility, FactInsertStatus,
  NewFact, FactListOpts, FactsHealth,
} from '../engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../engine.ts';
import { tryParseEmbedding } from '../utils.ts';

/** Narrow slice of PostgresEngine the facts operations use. */
export interface PgFactsDeps {
  /** Live postgres.js pool. Getter-backed at the call site so the
   *  connection check fires exactly when the original engine `sql` read did. */
  readonly sql: PgSql;
  /** Cast-suffix probe for facts.embedding (cache state lives on the engine). */
  resolveFactsEmbeddingCast(): Promise<'::vector' | '::halfvec'>;
}

export async function insertFact(
  deps: PgFactsDeps,
    input: NewFact,
    ctx: { source_id: string; supersedeId?: number },
  ): Promise<{ id: number; status: FactInsertStatus }> {
    const sql = deps.sql;
    const validFrom = input.valid_from ?? new Date();
    const validUntil = input.valid_until ?? null;
    const kind = input.kind ?? 'fact';
    const visibility = input.visibility ?? 'private';
    const notability = input.notability ?? 'medium';
    const confidence = input.confidence ?? 1.0;
    const entitySlug = input.entity_slug ?? null;
    const context = input.context ?? null;
    const sourceSession = input.source_session ?? null;
    const embedding = input.embedding ?? null;
    const embeddedAt = embedding ? new Date() : null;
    const embedLit = embedding ? toPgVectorLiteral(embedding) : null;
    // v0.41.15.0 (T6, codex #20): match cast to actual column type so
    // a halfvec(N) column doesn't pay an implicit-cast round-trip + can
    // run on pgvector versions that lack the auto vector→halfvec cast.
    const castSuffix = await deps.resolveFactsEmbeddingCast();
    // v0.35.4 (D-CDX-5) — typed-claim columns. All four nullable.
    const claimMetric = input.claim_metric ?? null;
    const claimValue  = input.claim_value  ?? null;
    const claimUnit   = input.claim_unit   ?? null;
    const claimPeriod = input.claim_period ?? null;

    if (ctx.supersedeId !== undefined) {
      // Per-entity advisory lock + atomic insert + supersede in one txn.
      const supersedeId = ctx.supersedeId;
      const newId = await sql.begin(async (tx) => {
        if (entitySlug) {
          // Lock-census (PR6 D5): COMPLIANT — key is already source-scoped (source_id || ':' || entity_slug).
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.source_id} || ':' || ${entitySlug}, 0))`;
        }
        const ins = await tx<Array<{ id: number }>>`
          INSERT INTO facts (
            source_id, entity_slug, fact, kind, visibility, notability, context,
            valid_from, valid_until, source, source_session, confidence,
            embedding, embedded_at,
            claim_metric, claim_value, claim_unit, claim_period
          ) VALUES (
            ${ctx.source_id}, ${entitySlug}, ${input.fact}, ${kind}, ${visibility}, ${notability}, ${context},
            ${validFrom}, ${validUntil}, ${input.source}, ${sourceSession}, ${confidence},
            ${embedLit === null ? null : tx.unsafe(`'${embedLit}'${castSuffix}`)}, ${embeddedAt},
            ${claimMetric}, ${claimValue}, ${claimUnit}, ${claimPeriod}
          ) RETURNING id
        `;
        const id = Number(ins[0].id);
        await tx`UPDATE facts SET expired_at = now(), superseded_by = ${id}
                 WHERE id = ${supersedeId} AND expired_at IS NULL`;
        return id;
      });
      return { id: newId, status: 'superseded' };
    }

    // Plain insert path with optional advisory lock for the dedup window.
    const id = await sql.begin(async (tx) => {
      if (entitySlug) {
        // Lock-census (PR6 D5): COMPLIANT — key is already source-scoped (source_id || ':' || entity_slug).
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.source_id} || ':' || ${entitySlug}, 0))`;
      }
      const ins = await tx<Array<{ id: number }>>`
        INSERT INTO facts (
          source_id, entity_slug, fact, kind, visibility, notability, context,
          valid_from, valid_until, source, source_session, confidence,
          embedding, embedded_at,
          claim_metric, claim_value, claim_unit, claim_period
        ) VALUES (
          ${ctx.source_id}, ${entitySlug}, ${input.fact}, ${kind}, ${visibility}, ${notability}, ${context},
          ${validFrom}, ${validUntil}, ${input.source}, ${sourceSession}, ${confidence},
          ${embedLit === null ? null : tx.unsafe(`'${embedLit}'${castSuffix}`)}, ${embeddedAt},
          ${claimMetric}, ${claimValue}, ${claimUnit}, ${claimPeriod}
        ) RETURNING id
      `;
      return Number(ins[0].id);
    });
    return { id, status: 'inserted' };
  }

export async function expireFact(deps: PgFactsDeps, id: number, opts?: { supersededBy?: number; at?: Date }): Promise<boolean> {
    const sql = deps.sql;
    const at = opts?.at ?? new Date();
    const supersededBy = opts?.supersededBy ?? null;
    const result = await sql`
      UPDATE facts SET expired_at = ${at}, superseded_by = COALESCE(${supersededBy}, superseded_by)
      WHERE id = ${id} AND expired_at IS NULL
    `;
    return (result.count ?? 0) > 0;
  }

export async function insertFacts(
  deps: PgFactsDeps,
    rows: Array<NewFact & { row_num: number; source_markdown_slug: string }>,
    ctx: { source_id: string },
  ): Promise<{ inserted: number; ids: number[] }> {
    if (rows.length === 0) return { inserted: 0, ids: [] };

    const sql = deps.sql;
    // v0.41.15.0 (T6, codex #20): resolve the embedding-cast suffix
    // ONCE per process so the cast matches the actual column type
    // (halfvec vs vector). The probe is cached after first call.
    const castSuffix = await deps.resolveFactsEmbeddingCast();
    // Single transaction so the v51 partial UNIQUE index can roll back
    // the whole batch on constraint violation. Per-row INSERTs (not
    // multi-row VALUES) keep the embedding-vs-no-embedding branching
    // readable; batch sizes are small (5-30 rows per page in practice).
    // No supersede flow in this path — fence reconciliation is the
    // canonical source-of-truth direction, not the consolidator path.
    const ids = await sql.begin(async (tx) => {
      const out: number[] = [];
      for (const input of rows) {
        const validFrom = input.valid_from ?? new Date();
        const validUntil = input.valid_until ?? null;
        const kind = input.kind ?? 'fact';
        const visibility = input.visibility ?? 'private';
        const notability = input.notability ?? 'medium';
        const confidence = input.confidence ?? 1.0;
        const entitySlug = input.entity_slug ?? null;
        const context = input.context ?? null;
        const sourceSession = input.source_session ?? null;
        const embedding = input.embedding ?? null;
        const embeddedAt = embedding ? new Date() : null;
        const embedLit = embedding ? toPgVectorLiteral(embedding) : null;
        // v0.35.4 (D-CDX-5) — typed-claim columns. All four nullable.
        const claimMetric = input.claim_metric ?? null;
        const claimValue  = input.claim_value  ?? null;
        const claimUnit   = input.claim_unit   ?? null;
        const claimPeriod = input.claim_period ?? null;
        // v0.40.2.0 — event_type column (Commit 1 migration v89).
        const eventType   = input.event_type   ?? null;

        const ins = await tx<Array<{ id: number }>>`
          INSERT INTO facts (
            source_id, entity_slug, fact, kind, visibility, notability, context,
            valid_from, valid_until, source, source_session, confidence,
            embedding, embedded_at,
            row_num, source_markdown_slug,
            claim_metric, claim_value, claim_unit, claim_period,
            event_type
          ) VALUES (
            ${ctx.source_id}, ${entitySlug}, ${input.fact}, ${kind}, ${visibility}, ${notability}, ${context},
            ${validFrom}, ${validUntil}, ${input.source}, ${sourceSession}, ${confidence},
            ${embedLit === null ? null : tx.unsafe(`'${embedLit}'${castSuffix}`)}, ${embeddedAt},
            ${input.row_num}, ${input.source_markdown_slug},
            ${claimMetric}, ${claimValue}, ${claimUnit}, ${claimPeriod},
            ${eventType}
          )
          ON CONFLICT (source_id, source_markdown_slug, row_num)
          WHERE row_num IS NOT NULL
          DO NOTHING
          RETURNING id
        `;
        if (ins[0]) out.push(Number(ins[0].id));
      }
      return out;
    });
    return { inserted: ids.length, ids };
  }

export async function deleteFactsForPage(
  deps: PgFactsDeps,
    slug: string,
    source_id: string,
    opts?: { excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean },
  ): Promise<{ deleted: number }> {
    const sql = deps.sql;
    const prefixes = opts?.excludeSourcePrefixes;
    // #2646: keep soft-expired legacy rows (row_num NULL — never
    // fence-owned) so a fence reconcile can't destroy forget_fact's
    // legacy DB-only forget record.
    const expiredLegacyFilter = opts?.preserveExpiredLegacy
      ? sql`AND NOT (row_num IS NULL AND expired_at IS NOT NULL)`
      : sql``;
    if (prefixes && prefixes.length > 0) {
      // #1928: keep rows whose `source` matches an excluded prefix (e.g.
      // `cli:` conversation facts). COALESCE so NULL/empty-source fence rows
      // stay deletable — only the explicitly-protected prefixes survive.
      const patterns = prefixes.map(p => `${p}%`);
      const result = await sql`
        DELETE FROM facts
        WHERE source_id = ${source_id}
          AND source_markdown_slug = ${slug}
          AND NOT (COALESCE(source, '') LIKE ANY(${patterns}))
          ${expiredLegacyFilter}
      `;
      return { deleted: result.count ?? 0 };
    }
    const result = await sql`
      DELETE FROM facts WHERE source_id = ${source_id} AND source_markdown_slug = ${slug} ${expiredLegacyFilter}
    `;
    return { deleted: result.count ?? 0 };
  }

export async function listFactsByEntity(
  deps: PgFactsDeps,
    source_id: string,
    entitySlug: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    const sql = deps.sql;
    const limit = clampSearchLimit(opts?.limit, 50, MAX_SEARCH_LIMIT);
    const offset = Math.max(0, opts?.offset ?? 0);
    const activeOnly = opts?.activeOnly !== false;
    const kinds = (opts?.kinds && opts.kinds.length > 0) ? opts.kinds : null;
    const visibility = (opts?.visibility && opts.visibility.length > 0) ? opts.visibility : null;
    const rows = await sql<FactRowSqlShape[]>`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND entity_slug = ${entitySlug}
        ${activeOnly ? sql`AND expired_at IS NULL` : sql``}
        ${kinds ? sql`AND kind = ANY(${kinds}::text[])` : sql``}
        ${visibility ? sql`AND visibility = ANY(${visibility}::text[])` : sql``}
      ORDER BY valid_from DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(rowToFactPg);
  }

export async function listFactsSince(
  deps: PgFactsDeps,
    source_id: string,
    since: Date,
    opts?: FactListOpts & { entitySlug?: string },
  ): Promise<FactRow[]> {
    const sql = deps.sql;
    const limit = clampSearchLimit(opts?.limit, 50, MAX_SEARCH_LIMIT);
    const offset = Math.max(0, opts?.offset ?? 0);
    const activeOnly = opts?.activeOnly !== false;
    const kinds = (opts?.kinds && opts.kinds.length > 0) ? opts.kinds : null;
    const visibility = (opts?.visibility && opts.visibility.length > 0) ? opts.visibility : null;
    const entitySlug = opts?.entitySlug ?? null;
    const rows = await sql<FactRowSqlShape[]>`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND created_at >= ${since}
        ${entitySlug ? sql`AND entity_slug = ${entitySlug}` : sql``}
        ${activeOnly ? sql`AND expired_at IS NULL` : sql``}
        ${kinds ? sql`AND kind = ANY(${kinds}::text[])` : sql``}
        ${visibility ? sql`AND visibility = ANY(${visibility}::text[])` : sql``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(rowToFactPg);
  }

export async function listFactsBySession(
  deps: PgFactsDeps,
    source_id: string,
    sessionId: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    const sql = deps.sql;
    const limit = clampSearchLimit(opts?.limit, 50, MAX_SEARCH_LIMIT);
    const offset = Math.max(0, opts?.offset ?? 0);
    const activeOnly = opts?.activeOnly !== false;
    const kinds = (opts?.kinds && opts.kinds.length > 0) ? opts.kinds : null;
    const visibility = (opts?.visibility && opts.visibility.length > 0) ? opts.visibility : null;
    const rows = await sql<FactRowSqlShape[]>`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND source_session = ${sessionId}
        ${activeOnly ? sql`AND expired_at IS NULL` : sql``}
        ${kinds ? sql`AND kind = ANY(${kinds}::text[])` : sql``}
        ${visibility ? sql`AND visibility = ANY(${visibility}::text[])` : sql``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(rowToFactPg);
  }

export async function listSupersessions(
  deps: PgFactsDeps,
    source_id: string,
    opts?: { since?: Date; limit?: number; visibility?: ('private' | 'world')[] },
  ): Promise<FactRow[]> {
    const sql = deps.sql;
    const limit = clampSearchLimit(opts?.limit, 50, MAX_SEARCH_LIMIT);
    const since = opts?.since ?? null;
    const visibility = (opts?.visibility && opts.visibility.length > 0) ? opts.visibility : null;
    const rows = await sql<FactRowSqlShape[]>`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND expired_at IS NOT NULL
        AND superseded_by IS NOT NULL
        ${since ? sql`AND expired_at >= ${since}` : sql``}
        ${visibility ? sql`AND visibility = ANY(${visibility}::text[])` : sql``}
      ORDER BY expired_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToFactPg);
  }

export async function countUnconsolidatedFacts(deps: PgFactsDeps, source_id: string): Promise<number> {
    const sql = deps.sql;
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM facts
      WHERE source_id = ${source_id}
        AND consolidated_at IS NULL
        AND expired_at IS NULL
    `;
    return Number(rows[0]?.count ?? 0);
  }

export async function findCandidateDuplicates(
  deps: PgFactsDeps,
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array },
  ): Promise<FactRow[]> {
    const sql = deps.sql;
    const k = Math.min(Math.max(opts?.k ?? 5, 1), 20);
    if (opts?.embedding) {
      const lit = toPgVectorLiteral(opts.embedding);
      const rows = await sql<FactRowSqlShape[]>`
        SELECT * FROM facts
        WHERE source_id = ${source_id}
          AND entity_slug = ${entitySlug}
          AND expired_at IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${sql.unsafe(`'${lit}'::vector`)}
        LIMIT ${k}
      `;
      return rows.map(rowToFactPg);
    }
    const rows = await sql<FactRowSqlShape[]>`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND entity_slug = ${entitySlug}
        AND expired_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ${k}
    `;
    return rows.map(rowToFactPg);
  }

export async function consolidateFact(deps: PgFactsDeps, id: number, takeId: number): Promise<void> {
    const sql = deps.sql;
    await sql`UPDATE facts SET consolidated_at = now(), consolidated_into = ${takeId} WHERE id = ${id}`;
  }

export async function findTrajectory(deps: PgFactsDeps, opts: import('../engine.ts').TrajectoryOpts): Promise<import('../engine.ts').TrajectoryPoint[]> {
    const sql = deps.sql;
    const limit = clampSearchLimit(opts.limit, 100, 500);
    const sinceDate = opts.since ? new Date(opts.since) : null;
    const untilDate = opts.until ? new Date(opts.until) : null;
    const metric = opts.metric ?? null;
    const kind = opts.kind ?? 'all';
    const useArray = Array.isArray(opts.sourceIds) && opts.sourceIds.length > 0;
    const sourceIds = useArray ? opts.sourceIds! : null;
    const sourceId = opts.sourceId ?? 'default';
    const remoteFilter = opts.remote === true;

    // Source-scope predicate: array path (federated) wins over scalar.
    // Engine.ts contract: returns chronological points; regressions +
    // drift_score are computed by the caller (src/core/trajectory.ts).
    // v0.40.2.0 — kind filter ('all'|'metric'|'event'); event_type column.
    const rows = await sql<Array<{
      id: number;
      valid_from: Date;
      claim_metric: string | null;
      claim_value: number | null;
      claim_unit: string | null;
      claim_period: string | null;
      event_type: string | null;
      fact: string;
      source_session: string | null;
      source_markdown_slug: string | null;
      embedding: string | null;
    }>>`
      SELECT id, valid_from,
             claim_metric, claim_value, claim_unit, claim_period,
             event_type,
             fact, source_session, source_markdown_slug,
             embedding::text AS embedding
      FROM facts
      WHERE ${useArray ? sql`source_id = ANY(${sourceIds}::text[])` : sql`source_id = ${sourceId}`}
        AND entity_slug = ${opts.entitySlug}
        AND expired_at IS NULL
        ${remoteFilter ? sql`AND visibility = 'world'` : sql``}
        ${metric !== null ? sql`AND claim_metric = ${metric}` : sql``}
        ${kind === 'metric' ? sql`AND claim_metric IS NOT NULL` : sql``}
        ${kind === 'event' ? sql`AND event_type IS NOT NULL` : sql``}
        ${sinceDate ? sql`AND valid_from >= ${sinceDate}` : sql``}
        ${untilDate ? sql`AND valid_from <= ${untilDate}` : sql``}
      ORDER BY valid_from ASC, id ASC
      LIMIT ${limit}
    `;

    return rows.map(r => ({
      fact_id: Number(r.id),
      valid_from: r.valid_from,
      metric: r.claim_metric,
      value: r.claim_value === null ? null : Number(r.claim_value),
      unit: r.claim_unit,
      period: r.claim_period,
      event_type: r.event_type,
      text: r.fact,
      source_session: r.source_session,
      source_markdown_slug: r.source_markdown_slug,
      embedding: tryParseEmbedding(r.embedding),
    }));
  }

export async function getFactsHealth(deps: PgFactsDeps, source_id: string): Promise<FactsHealth> {
    const sql = deps.sql;
    const totals = await sql<Array<{
      total_active: bigint; total_today: bigint; total_week: bigint;
      total_expired: bigint; total_consolidated: bigint;
    }>>`
      SELECT
        COUNT(*) FILTER (WHERE expired_at IS NULL)                                     AS total_active,
        COUNT(*) FILTER (WHERE expired_at IS NULL AND created_at > now() - interval '24 hours') AS total_today,
        COUNT(*) FILTER (WHERE expired_at IS NULL AND created_at > now() - interval '7 days')   AS total_week,
        COUNT(*) FILTER (WHERE expired_at IS NOT NULL)                                 AS total_expired,
        COUNT(*) FILTER (WHERE consolidated_at IS NOT NULL)                            AS total_consolidated
      FROM facts WHERE source_id = ${source_id}
    `;
    const top = await sql<Array<{ entity_slug: string; count: bigint }>>`
      SELECT entity_slug, COUNT(*) AS count
      FROM facts
      WHERE source_id = ${source_id} AND expired_at IS NULL AND entity_slug IS NOT NULL
      GROUP BY entity_slug
      ORDER BY count DESC, entity_slug ASC
      LIMIT 5
    `;
    const r = totals[0] ?? {
      total_active: 0n, total_today: 0n, total_week: 0n, total_expired: 0n, total_consolidated: 0n,
    };
    return {
      source_id,
      total_active: Number(r.total_active),
      total_today: Number(r.total_today),
      total_week: Number(r.total_week),
      total_expired: Number(r.total_expired),
      total_consolidated: Number(r.total_consolidated),
      top_entities: top.map(t => ({ entity_slug: t.entity_slug, count: Number(t.count) })),
    };
  }

/**
 * Raw row shape returned from `SELECT * FROM facts` on Postgres.
 * postgres.js auto-decodes timestamps and numbers; embedding lands as
 * either a string ("[0.1,...]") or already-parsed array depending on type
 * codec — we handle both.
 */
interface FactRowSqlShape {
  id: number | bigint;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: FactKind;
  visibility: FactVisibility;
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date;
  valid_until: Date | null;
  expired_at: Date | null;
  superseded_by: number | bigint | null;
  consolidated_at: Date | null;
  consolidated_into: number | bigint | null;
  source: string;
  source_session: string | null;
  confidence: number | string;
  embedding: string | number[] | Float32Array | null;
  embedded_at: Date | null;
  created_at: Date;
}

function rowToFactPg(row: FactRowSqlShape): FactRow {
  let embedding: Float32Array | null = null;
  if (row.embedding != null) {
    if (row.embedding instanceof Float32Array) embedding = row.embedding;
    else if (Array.isArray(row.embedding)) embedding = new Float32Array(row.embedding);
    else if (typeof row.embedding === 'string') {
      const trimmed = row.embedding.trim();
      const inner = trimmed.startsWith('[') ? trimmed.slice(1, -1) : trimmed;
      const parts = inner.split(',').map(p => parseFloat(p.trim())).filter(Number.isFinite);
      embedding = parts.length > 0 ? new Float32Array(parts) : null;
    }
  }
  return {
    id: Number(row.id),
    source_id: row.source_id,
    entity_slug: row.entity_slug,
    fact: row.fact,
    kind: row.kind,
    visibility: row.visibility,
    // v0.31.2: notability column added by migration v46. Pre-v46 rows that
    // somehow survive a SELECT (shouldn't on a fully-migrated brain) fall
    // back to 'medium' to keep the contract total. Belt-and-suspenders with
    // the migration's NOT NULL DEFAULT.
    notability: row.notability ?? 'medium',
    context: row.context,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    expired_at: row.expired_at,
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
    consolidated_at: row.consolidated_at,
    consolidated_into: row.consolidated_into == null ? null : Number(row.consolidated_into),
    source: row.source,
    source_session: row.source_session,
    confidence: typeof row.confidence === 'string' ? parseFloat(row.confidence) : row.confidence,
    embedding,
    embedded_at: row.embedded_at,
    created_at: row.created_at,
  };
}

function toPgVectorLiteral(v: Float32Array | number[]): string {
  if (v instanceof Float32Array) return '[' + Array.from(v).join(',') + ']';
  return '[' + v.join(',') + ']';
}
