/**
 * v0.31: Hot memory — facts table operations, peeled out of PGLiteEngine
 * (containment sprint C15). Free functions over a NARROW deps surface — the
 * live PGLite handle only. Never the whole engine class.
 */
import type { PGlite } from '@electric-sql/pglite';
import type {
  FactRow, FactKind, FactVisibility, FactInsertStatus,
  NewFact, FactListOpts, FactsHealth,
} from '../engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../engine.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { resolveSupersededByRow, isInt4RowRef, type SupersedeTarget } from '../facts/supersede-resolve.ts';
import { escapeLikePattern } from '../cjk.ts';

/** Narrow slice of PGLiteEngine the facts operations use. */
export interface PgliteFactsDeps {
  /** Live PGLite handle. Getter-backed at the call site so the
   *  connect() check fires exactly when the original engine `db` read did. */
  readonly db: PGlite;
}

export async function insertFact(
  deps: PgliteFactsDeps,
    input: NewFact,
    ctx: { source_id: string; supersedeId?: number },
  ): Promise<{ id: number; status: FactInsertStatus }> {
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
    const embedStr = embedding ? toPgVectorLiteral(embedding) : null;
    // v0.35.4 (D-CDX-5) — typed-claim columns. All four nullable.
    const claimMetric = input.claim_metric ?? null;
    const claimValue  = input.claim_value  ?? null;
    const claimUnit   = input.claim_unit   ?? null;
    const claimPeriod = input.claim_period ?? null;

    if (ctx.supersedeId !== undefined) {
      // Supersede flow: insert new + expire old in one txn so observers never
      // see both rows active simultaneously.
      const result = await deps.db.transaction(async (tx) => {
        const ins = await tx.query<{ id: number }>(
          embedStr === null
            ? `INSERT INTO facts (
                 source_id, entity_slug, fact, kind, visibility, notability, context,
                 valid_from, valid_until, source, source_session, confidence,
                 embedding, embedded_at,
                 claim_metric, claim_value, claim_unit, claim_period
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 NULL, NULL,
                 $13, $14, $15, $16
               ) RETURNING id`
            : `INSERT INTO facts (
                 source_id, entity_slug, fact, kind, visibility, notability, context,
                 valid_from, valid_until, source, source_session, confidence,
                 embedding, embedded_at,
                 claim_metric, claim_value, claim_unit, claim_period
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 $13::vector, $14,
                 $15, $16, $17, $18
               ) RETURNING id`,
          embedStr === null
            ? [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, claimMetric, claimValue, claimUnit, claimPeriod]
            : [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, embedStr, embeddedAt, claimMetric, claimValue, claimUnit, claimPeriod],
        );
        const newId = ins.rows[0].id;
        await tx.query(
          `UPDATE facts SET expired_at = now(), superseded_by = $1
           WHERE id = $2 AND expired_at IS NULL`,
          [newId, ctx.supersedeId],
        );
        return newId;
      });
      return { id: result, status: 'superseded' };
    }

    const ins = await deps.db.query<{ id: number }>(
      embedStr === null
        ? `INSERT INTO facts (
             source_id, entity_slug, fact, kind, visibility, notability, context,
             valid_from, valid_until, source, source_session, confidence,
             embedding, embedded_at,
             claim_metric, claim_value, claim_unit, claim_period
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             NULL, NULL,
             $13, $14, $15, $16
           ) RETURNING id`
        : `INSERT INTO facts (
             source_id, entity_slug, fact, kind, visibility, notability, context,
             valid_from, valid_until, source, source_session, confidence,
             embedding, embedded_at,
             claim_metric, claim_value, claim_unit, claim_period
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             $13::vector, $14,
             $15, $16, $17, $18
           ) RETURNING id`,
      embedStr === null
        ? [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, claimMetric, claimValue, claimUnit, claimPeriod]
        : [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, embedStr, embeddedAt, claimMetric, claimValue, claimUnit, claimPeriod],
    );
    return { id: ins.rows[0].id, status: 'inserted' };
  }

export async function expireFact(deps: PgliteFactsDeps, id: number, opts?: { supersededBy?: number; at?: Date }): Promise<boolean> {
    const at = opts?.at ?? new Date();
    const result = await deps.db.query(
      `UPDATE facts SET expired_at = $1, superseded_by = COALESCE($2, superseded_by)
       WHERE id = $3 AND expired_at IS NULL`,
      [at, opts?.supersededBy ?? null, id],
    );
    return (result.affectedRows ?? 0) > 0;
  }

export async function insertFacts(
  deps: PgliteFactsDeps,
    rows: Array<NewFact & { row_num: number; source_markdown_slug: string; superseded_by_row?: number }>,
    ctx: { source_id: string },
    opts?: { deleteForPageFirst?: { slug: string; excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean } },
  ): Promise<{ inserted: number; ids: number[]; warnings: string[]; deleted: number }> {
    if (rows.length === 0) return { inserted: 0, ids: [], warnings: [], deleted: 0 };

    const warnings: string[] = [];
    // v0.46 (#3014): captured inside the transaction below when
    // deleteForPageFirst runs; stays 0 for the standalone insert path.
    let deleted = 0;
    // Single transaction so the v51 partial UNIQUE index can roll back the
    // whole batch on constraint violation. Per-row INSERTs (not multi-row
    // VALUES) keep the embedding-vs-no-embedding branching readable; batch
    // sizes are small (5-30 rows per page in practice) so the loop overhead
    // is negligible vs the embedding compute cost.
    // v0.46 (#3014): the fence path carries struck rows — `expired_at` is
    // stamped inline, and `superseded by #N` references are resolved to
    // `facts.superseded_by` in a second pass below (same transaction).
    const ids = await deps.db.transaction(async (tx) => {
      // v0.46 (#3014) — atomic reconcile: wipe the page's fence-owned rows
      // as the FIRST statement of this transaction so a failing insert
      // below rolls the delete back too. Inlined (not a deleteFactsForPage
      // call) so it shares this transaction. Delete scoping mirrors
      // deleteFactsForPage exactly (#1928 excludeSourcePrefixes + #2646
      // preserveExpiredLegacy).
      const del = opts?.deleteForPageFirst;
      if (del) {
        const expiredLegacyFilter = del.preserveExpiredLegacy
          ? ` AND NOT (row_num IS NULL AND expired_at IS NOT NULL)`
          : '';
        const prefixes = del.excludeSourcePrefixes;
        if (prefixes && prefixes.length > 0) {
          const patterns = prefixes.map(p => `${p}%`);
          const r = await tx.query(
            `DELETE FROM facts
               WHERE source_id = $1 AND source_markdown_slug = $2
                 AND NOT (COALESCE(source, '') LIKE ANY($3::text[]))${expiredLegacyFilter}`,
            [ctx.source_id, del.slug, patterns],
          );
          deleted = r.affectedRows ?? 0;
        } else {
          const r = await tx.query(
            `DELETE FROM facts WHERE source_id = $1 AND source_markdown_slug = $2${expiredLegacyFilter}`,
            [ctx.source_id, del.slug],
          );
          deleted = r.affectedRows ?? 0;
        }
      }
      const out: number[] = [];
      // Per-input inserted id, aligned to `rows` (null when the v51
      // ON CONFLICT DO NOTHING skipped the row) — the second pass below
      // must not index `out` positionally, or a skipped row would shift
      // every later UPDATE onto the wrong fact.
      const rowIds: Array<number | null> = [];
      for (const input of rows) {
        const validFrom = input.valid_from ?? new Date();
        const validUntil = input.valid_until ?? null;
        const expiredAt = input.expired_at ?? null;
        const kind = input.kind ?? 'fact';
        const visibility = input.visibility ?? 'private';
        const notability = input.notability ?? 'medium';
        const confidence = input.confidence ?? 1.0;
        const entitySlug = input.entity_slug ?? null;
        const context = input.context ?? null;
        const sourceSession = input.source_session ?? null;
        const embedding = input.embedding ?? null;
        const embeddedAt = embedding ? new Date() : null;
        const embedStr = embedding ? toPgVectorLiteral(embedding) : null;
        // v0.35.4 (D-CDX-5) — typed-claim columns. All four nullable.
        const claimMetric = input.claim_metric ?? null;
        const claimValue  = input.claim_value  ?? null;
        const claimUnit   = input.claim_unit   ?? null;
        const claimPeriod = input.claim_period ?? null;
        // v0.40.2.0 — event_type column (Commit 1 migration v89).
        const eventType   = input.event_type   ?? null;

        // Param-positional dispatch: embedStr presence shifts the trailing
        // slots by one. Order of named slots stays stable across both
        // branches: expired_at, embedded_at, row_num, source_markdown_slug,
        // claim_metric, claim_value, claim_unit, claim_period, event_type.
        const ins = await tx.query<{ id: number }>(
          embedStr === null
            ? `INSERT INTO facts (
                 source_id, entity_slug, fact, kind, visibility, notability, context,
                 valid_from, valid_until, expired_at, source, source_session, confidence,
                 embedding, embedded_at,
                 row_num, source_markdown_slug,
                 claim_metric, claim_value, claim_unit, claim_period,
                 event_type
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 NULL, $14,
                 $15, $16,
                 $17, $18, $19, $20,
                 $21
               )
               ON CONFLICT (source_id, source_markdown_slug, row_num)
               WHERE row_num IS NOT NULL
               DO NOTHING
               RETURNING id`
            : `INSERT INTO facts (
                 source_id, entity_slug, fact, kind, visibility, notability, context,
                 valid_from, valid_until, expired_at, source, source_session, confidence,
                 embedding, embedded_at,
                 row_num, source_markdown_slug,
                 claim_metric, claim_value, claim_unit, claim_period,
                 event_type
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 $14::vector, $15,
                 $16, $17,
                 $18, $19, $20, $21,
                 $22
               )
               ON CONFLICT (source_id, source_markdown_slug, row_num)
               WHERE row_num IS NOT NULL
               DO NOTHING
               RETURNING id`,
          embedStr === null
            ? [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, expiredAt, input.source, sourceSession, confidence, embeddedAt, input.row_num, input.source_markdown_slug, claimMetric, claimValue, claimUnit, claimPeriod, eventType]
            : [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, expiredAt, input.source, sourceSession, confidence, embedStr, embeddedAt, input.row_num, input.source_markdown_slug, claimMetric, claimValue, claimUnit, claimPeriod, eventType],
        );
        if (ins.rows[0]) out.push(ins.rows[0].id);
        rowIds.push(ins.rows[0] ? Number(ins.rows[0].id) : null);
      }

      // v0.46 (#3014) — second pass: resolve `superseded by #N` page-local
      // references to fact ids. Same transaction so a target row inserted
      // above is visible. Keyed on (source_id, source_markdown_slug,
      // row_num) — the v51 unique index — so a reference also resolves
      // against a target that already existed before this batch. A target
      // whose `expired_at` is set is itself struck (chain) and rejected.
      for (let i = 0; i < rows.length; i++) {
        const targetRow = rows[i].superseded_by_row;
        if (targetRow === undefined || rowIds[i] === null) continue;
        const slug = rows[i].source_markdown_slug;
        // Only look up an int4-safe target. An absurd `#N` (11+ digits)
        // would overflow the `row_num` comparison and abort the cycle;
        // skipping the lookup leaves `target` undefined, so
        // resolveSupersededByRow treats it as a dangling reference (NULL +
        // warning) instead of throwing.
        let target: SupersedeTarget | undefined;
        if (isInt4RowRef(targetRow)) {
          const found = await tx.query<{ id: number; expired_at: Date | string | null }>(
            `SELECT id, expired_at FROM facts
               WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num = $3
               LIMIT 1`,
            [ctx.source_id, slug, targetRow],
          );
          const hit = found.rows[0];
          target = hit
            ? { id: Number(hit.id), struck: hit.expired_at != null }
            : undefined;
        }
        const { superseded_by, warning } = resolveSupersededByRow(rows[i].row_num, targetRow, target, slug);
        if (warning) warnings.push(warning);
        if (superseded_by !== null) {
          await tx.query(`UPDATE facts SET superseded_by = $1 WHERE id = $2`, [superseded_by, rowIds[i]]);
        }
      }
      return out;
    });
    return { inserted: ids.length, ids, warnings, deleted };
  }

export async function deleteFactsForPage(
  deps: PgliteFactsDeps,
    slug: string,
    source_id: string,
    opts?: { excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean },
  ): Promise<{ deleted: number }> {
    const prefixes = opts?.excludeSourcePrefixes;
    // #2646: keep soft-expired legacy rows (row_num NULL — never
    // fence-owned) so a fence reconcile can't destroy forget_fact's
    // legacy DB-only forget record.
    const expiredLegacyFilter = opts?.preserveExpiredLegacy
      ? ` AND NOT (row_num IS NULL AND expired_at IS NOT NULL)`
      : '';
    if (prefixes && prefixes.length > 0) {
      // #1928: keep rows whose `source` matches an excluded prefix (e.g.
      // `cli:` conversation facts). COALESCE so NULL/empty-source fence rows
      // stay deletable — only the explicitly-protected prefixes survive.
      const patterns = prefixes.map(p => `${p}%`);
      const result = await deps.db.query(
        `DELETE FROM facts
           WHERE source_id = $1 AND source_markdown_slug = $2
             AND NOT (COALESCE(source, '') LIKE ANY($3::text[]))${expiredLegacyFilter}`,
        [source_id, slug, patterns],
      );
      return { deleted: result.affectedRows ?? 0 };
    }
    const result = await deps.db.query(
      `DELETE FROM facts WHERE source_id = $1 AND source_markdown_slug = $2${expiredLegacyFilter}`,
      [source_id, slug],
    );
    return { deleted: result.affectedRows ?? 0 };
  }

export async function listFactsByEntity(
  deps: PgliteFactsDeps,
    source_id: string,
    entitySlug: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    const where: string[] = [`entity_slug = $entitySlug`];
    const whereParams: Record<string, unknown> = { entitySlug };
    if (opts?.excludeAuditRows === true) {
      where.push(`NOT (source = ANY($auditSources))`);
      whereParams.auditSources = [...AUDIT_ROW_SOURCES];
    }
    return _listFacts(deps, source_id, {
      ...opts,
      whereClauses: where,
      whereParams,
      order: 'valid_from DESC, id DESC',
    });
  }

export async function listFactsSince(
  deps: PgliteFactsDeps,
    source_id: string,
    since: Date,
    opts?: FactListOpts & { entitySlug?: string },
  ): Promise<FactRow[]> {
    const tsExpr = opts?.eventTime === true ? 'COALESCE(valid_from, created_at)' : 'created_at';
    const where: string[] = [`${tsExpr} >= $since`];
    const params: Record<string, unknown> = { since };
    if (opts?.entitySlug) {
      where.push(`entity_slug = $entitySlug`);
      params.entitySlug = opts.entitySlug;
    }
    if (opts?.excludeAuditRows === true) {
      where.push(`NOT (source = ANY($auditSources))`);
      params.auditSources = [...AUDIT_ROW_SOURCES];
    }
    return _listFacts(deps, source_id, {
      ...opts,
      whereClauses: where,
      whereParams: params,
      order: `${tsExpr} DESC, id DESC`,
    });
  }

export async function listFactsBySession(
  deps: PgliteFactsDeps,
    source_id: string,
    sessionId: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    const where: string[] = [`source_session = $sessionId`];
    const whereParams: Record<string, unknown> = { sessionId };
    if (opts?.excludeAuditRows === true) {
      where.push(`NOT (source = ANY($auditSources))`);
      whereParams.auditSources = [...AUDIT_ROW_SOURCES];
    }
    return _listFacts(deps, source_id, {
      ...opts,
      whereClauses: where,
      whereParams,
      order: 'created_at DESC, id DESC',
    });
  }

export async function listSupersessions(
  deps: PgliteFactsDeps,
    source_id: string,
    opts?: { since?: Date; limit?: number; visibility?: ('private' | 'world')[] },
  ): Promise<FactRow[]> {
    // v0.46 (#3014) — filter on `superseded_by` alone; the ontology
    // writer closes a superseded row via `valid_until` (not `expired_at`,
    // which would break its `--asof` time-travel), so requiring both
    // columns dropped every ontology supersession AND every fence-authored
    // one. Order / `since` fall back to `valid_until` when `expired_at` is
    // NULL.
    const where: string[] = [`superseded_by IS NOT NULL`];
    const params: Record<string, unknown> = {};
    if (opts?.since) {
      where.push(`COALESCE(expired_at, valid_until) >= $since`);
      params.since = opts.since;
    }
    return _listFacts(deps, source_id, {
      activeOnly: false,
      limit: opts?.limit,
      visibility: opts?.visibility,
      whereClauses: where,
      whereParams: params,
      order: 'COALESCE(expired_at, valid_until) DESC, id DESC',
    });
  }

export async function countUnconsolidatedFacts(deps: PgliteFactsDeps, source_id: string): Promise<number> {
    // Audit checkpoint rows never set consolidated_at, so without the source
    // exclusion each one counts as forever-pending consolidation backlog.
    const r = await deps.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM facts
       WHERE source_id = $1 AND consolidated_at IS NULL AND expired_at IS NULL
         AND NOT (source = ANY($2::text[]))`,
      [source_id, [...AUDIT_ROW_SOURCES]],
    );
    return Number(r.rows[0]?.count ?? 0);
  }

export async function findCandidateDuplicates(
  deps: PgliteFactsDeps,
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array },
  ): Promise<FactRow[]> {
    const k = Math.min(Math.max(opts?.k ?? 5, 1), 20);
    if (opts?.embedding) {
      // Embedding-cosine ordered candidates within the entity bucket.
      const vec = toPgVectorLiteral(opts.embedding);
      const result = await deps.db.query<FactRowSqlShape>(
        `SELECT * FROM facts
         WHERE source_id = $1
           AND entity_slug = $2
           AND expired_at IS NULL
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $3::vector
         LIMIT $4`,
        [source_id, entitySlug, vec, k],
      );
      return result.rows.map(rowToFact);
    }
    // Recency fallback when no embedding.
    const result = await deps.db.query<FactRowSqlShape>(
      `SELECT * FROM facts
       WHERE source_id = $1
         AND entity_slug = $2
         AND expired_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [source_id, entitySlug, k],
    );
    return result.rows.map(rowToFact);
  }

export async function findTrajectory(deps: PgliteFactsDeps, opts: import('../engine.ts').TrajectoryOpts): Promise<import('../engine.ts').TrajectoryPoint[]> {
    const limit = clampSearchLimit(opts.limit, 100, 500);
    const sinceDate = opts.since ? new Date(opts.since) : null;
    const untilDate = opts.until ? new Date(opts.until) : null;
    const metric = opts.metric ?? null;
    const kind = opts.kind ?? 'all';
    const useArray = Array.isArray(opts.sourceIds) && opts.sourceIds.length > 0;
    const sourceIds = useArray ? opts.sourceIds! : null;
    const sourceId = opts.sourceId ?? 'default';
    // Fail-closed (CV6 / v0.26.9 F7b posture): anything not strictly local
    // is remote. An omitted flag (cast-bypassed context, caller that forgot
    // to thread it) degrades to world-only reads, never to a private-fact leak.
    const remoteFilter = opts.remote !== false;

    // Build SQL dynamically. PGLite uses $N positional params; we
    // assemble the WHERE clauses + params array in tandem to keep them
    // aligned. Final shape is single SELECT, ORDER BY (valid_from, id) ASC.
    const where: string[] = [
      useArray ? `source_id = ANY($1::text[])` : `source_id = $1`,
      `entity_slug = $2`,
      `expired_at IS NULL`,
    ];
    const params: unknown[] = [useArray ? sourceIds : sourceId, opts.entitySlug];
    let p = 3;
    if (remoteFilter) {
      where.push(`visibility = 'world'`);
    }
    if (metric !== null) {
      where.push(`claim_metric = $${p}`);
      params.push(metric);
      p += 1;
    }
    // v0.40.2.0 — kind filter. 'all' (default) no-ops. 'metric' restricts
    // to typed-claim rows; 'event' restricts to event-shaped rows.
    if (kind === 'metric') {
      where.push(`claim_metric IS NOT NULL`);
    } else if (kind === 'event') {
      where.push(`event_type IS NOT NULL`);
    }
    if (sinceDate) {
      where.push(`valid_from >= $${p}`);
      params.push(sinceDate);
      p += 1;
    }
    if (untilDate) {
      where.push(`valid_from <= $${p}`);
      params.push(untilDate);
      p += 1;
    }
    params.push(limit);
    const limitPlaceholder = p;

    const sqlText = `
      SELECT id, valid_from,
             claim_metric, claim_value, claim_unit, claim_period,
             event_type,
             fact, source_session, source_markdown_slug,
             embedding
      FROM facts
      WHERE ${where.join(' AND ')}
      ORDER BY valid_from ASC, id ASC
      LIMIT $${limitPlaceholder}
    `;
    const result = await deps.db.query<{
      id: number;
      valid_from: Date | string;
      claim_metric: string | null;
      claim_value: number | null;
      claim_unit: string | null;
      claim_period: string | null;
      event_type: string | null;
      fact: string;
      source_session: string | null;
      source_markdown_slug: string | null;
      embedding: string | number[] | Float32Array | null;
    }>(sqlText, params);

    return result.rows.map(r => {
      // Inline embedding parser — mirrors rowToFact() at line 3911.
      let embedding: Float32Array | null = null;
      if (r.embedding != null) {
        if (r.embedding instanceof Float32Array) embedding = r.embedding;
        else if (Array.isArray(r.embedding)) embedding = new Float32Array(r.embedding);
        else if (typeof r.embedding === 'string') {
          const trimmed = r.embedding.trim();
          const inner = trimmed.startsWith('[') ? trimmed.slice(1, -1) : trimmed;
          const parts = inner.split(',').map(s => parseFloat(s.trim())).filter(Number.isFinite);
          embedding = parts.length > 0 ? new Float32Array(parts) : null;
        }
      }
      return {
        fact_id: Number(r.id),
        valid_from: r.valid_from instanceof Date ? r.valid_from : new Date(r.valid_from),
        metric: r.claim_metric,
        value: r.claim_value === null ? null : Number(r.claim_value),
        unit: r.claim_unit,
        period: r.claim_period,
        event_type: r.event_type,
        text: r.fact,
        source_session: r.source_session,
        source_markdown_slug: r.source_markdown_slug,
        embedding,
      };
    });
  }

export async function consolidateFact(deps: PgliteFactsDeps, id: number, takeId: number): Promise<void> {
    await deps.db.query(
      `UPDATE facts SET consolidated_at = now(), consolidated_into = $1 WHERE id = $2`,
      [takeId, id],
    );
  }

export async function getFactsHealth(deps: PgliteFactsDeps, source_id: string): Promise<FactsHealth> {
    const total = await deps.db.query<{
      total_active: number; total_today: number; total_week: number;
      total_expired: number; total_consolidated: number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE expired_at IS NULL)                                    AS total_active,
         COUNT(*) FILTER (WHERE expired_at IS NULL AND created_at > now() - interval '24 hours') AS total_today,
         COUNT(*) FILTER (WHERE expired_at IS NULL AND created_at > now() - interval '7 days')   AS total_week,
         COUNT(*) FILTER (WHERE expired_at IS NOT NULL)                                AS total_expired,
         COUNT(*) FILTER (WHERE consolidated_at IS NOT NULL)                           AS total_consolidated
       FROM facts WHERE source_id = $1`,
      [source_id],
    );
    const top = await deps.db.query<{ entity_slug: string; count: number }>(
      `SELECT entity_slug, COUNT(*)::int AS count
       FROM facts
       WHERE source_id = $1 AND expired_at IS NULL AND entity_slug IS NOT NULL
       GROUP BY entity_slug
       ORDER BY count DESC, entity_slug ASC
       LIMIT 5`,
      [source_id],
    );
    const r = total.rows[0] ?? {
      total_active: 0, total_today: 0, total_week: 0, total_expired: 0, total_consolidated: 0,
    };
    return {
      source_id,
      total_active: Number(r.total_active),
      total_today: Number(r.total_today),
      total_week: Number(r.total_week),
      total_expired: Number(r.total_expired),
      total_consolidated: Number(r.total_consolidated),
      top_entities: top.rows.map(t => ({ entity_slug: t.entity_slug, count: Number(t.count) })),
    };
  }

  /**
   * Internal helper: shared list-facts query builder.
   * Supports source_id always, plus arbitrary additional WHERE clauses.
   */
async function _listFacts(
  deps: PgliteFactsDeps,
    source_id: string,
    opts: FactListOpts & {
      whereClauses?: string[];
      whereParams?: Record<string, unknown>;
      order: string;
    },
  ): Promise<FactRow[]> {
    const limit = clampSearchLimit(opts.limit, 50, MAX_SEARCH_LIMIT);
    const offset = Math.max(0, opts.offset ?? 0);
    const whereParts: string[] = [`source_id = $source_id`];
    const params: Record<string, unknown> = { source_id };
    if (opts.activeOnly !== false) {
      whereParts.push(`expired_at IS NULL`);
    }
    if (opts.unconsolidatedOnly === true) {
      whereParts.push(`consolidated_at IS NULL`);
    }
    if (opts.kinds && opts.kinds.length > 0) {
      whereParts.push(`kind = ANY($kinds)`);
      params.kinds = opts.kinds;
    }
    if (opts.visibility && opts.visibility.length > 0) {
      whereParts.push(`visibility = ANY($visibility)`);
      params.visibility = opts.visibility;
    }
    if (opts.grep && opts.grep.trim()) {
      // SQL-side substring filter (before limit) — a client-side post-limit
      // grep silently misses matches outside the newest-N window on
      // high-cardinality entities. Parity with the postgres engine.
      whereParts.push(`fact ILIKE $grepPat ESCAPE '\\'`);
      params.grepPat = '%' + escapeLikePattern(opts.grep.trim()) + '%';
    }
    for (const c of opts.whereClauses ?? []) whereParts.push(c);
    Object.assign(params, opts.whereParams ?? {});

    // Convert $name placeholders to numbered $1, $2, ... for PGLite.
    const orderedKeys = Object.keys(params);
    const indexFor = (name: string): number => orderedKeys.indexOf(name) + 1;
    const sql = `SELECT * FROM facts
       WHERE ${whereParts.join(' AND ').replace(/\$(\w+)/g, (_m, k) => `$${indexFor(k)}`)}
       ORDER BY ${opts.order}
       LIMIT ${limit} OFFSET ${offset}`;
    const result = await deps.db.query<FactRowSqlShape>(sql, orderedKeys.map(k => params[k]));
    return result.rows.map(rowToFact);
  }

/**
 * Raw row shape returned from `SELECT * FROM facts`. The `embedding`
 * column comes back as a string (`[0.1,0.2,...]`) on PGLite when
 * postgres-style types aren't auto-decoded; we parse on the way out.
 */
interface FactRowSqlShape {
  id: number;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: FactKind;
  visibility: FactVisibility;
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date | string;
  valid_until: Date | string | null;
  expired_at: Date | string | null;
  superseded_by: number | null;
  consolidated_at: Date | string | null;
  consolidated_into: number | null;
  source: string;
  source_session: string | null;
  confidence: number;
  embedding: string | number[] | Float32Array | null;
  embedded_at: Date | string | null;
  created_at: Date | string;
}

function toDate(v: Date | string | null): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  return new Date(v);
}

function rowToFact(row: FactRowSqlShape): FactRow {
  let embedding: Float32Array | null = null;
  if (row.embedding != null) {
    if (row.embedding instanceof Float32Array) embedding = row.embedding;
    else if (Array.isArray(row.embedding)) embedding = new Float32Array(row.embedding);
    else if (typeof row.embedding === 'string') {
      // pgvector text format: "[0.1,0.2,...]"
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
    // v0.31.2: notability column added by migration v46. Same fallback
    // as Postgres (belt-and-suspenders with the NOT NULL DEFAULT).
    notability: row.notability ?? 'medium',
    context: row.context,
    valid_from: toDate(row.valid_from)!,
    valid_until: toDate(row.valid_until),
    expired_at: toDate(row.expired_at),
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
    consolidated_at: toDate(row.consolidated_at),
    consolidated_into: row.consolidated_into == null ? null : Number(row.consolidated_into),
    source: row.source,
    source_session: row.source_session,
    confidence: Number(row.confidence),
    embedding,
    embedded_at: toDate(row.embedded_at),
    created_at: toDate(row.created_at)!,
  };
}

/**
 * Encode a Float32Array as the pgvector text-form literal `[0.1,0.2,...]`.
 * Both PGLite and Postgres accept this when the parameter is cast to ::vector.
 */
function toPgVectorLiteral(v: Float32Array | number[]): string {
  if (v instanceof Float32Array) return '[' + Array.from(v).join(',') + ']';
  return '[' + v.join(',') + ']';
}
