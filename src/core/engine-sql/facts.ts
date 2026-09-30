/**
 * Hot-memory facts: one SQL implementation for both engines (refactor wave 1,
 * W1-core C11). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/facts.json`); PGLite runs the same statements. Dialect
 * capabilities (docs/designs/refactor-wave-1/w1-inventory.md):
 *   - transactionAdvisoryLocks: Postgres serializes same-entity inserts with
 *     `pg_advisory_xact_lock` inside a transaction; PGLite (single connection)
 *     never locked and its plain insert never opened a transaction.
 *   - probesEmbeddingCast: Postgres matches the vector literal cast to the
 *     live `facts.embedding` column type (`::vector` | `::halfvec`); PGLite
 *     always cast `::vector` on master (its bundled pgvector assignment-casts
 *     to the halfvec column).
 * Every read was unscoped on master (EO4 inventory): reads take
 * `LegacyUnscopedRead`.
 */
import type {
  FactRow, FactKind, FactVisibility, FactInsertStatus,
  NewFact, FactListOpts, FactsHealth,
} from '../engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../engine.ts';
import { tryParseEmbedding } from '../utils.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { resolveSupersededByRow, isInt4RowRef, supersessionChainOf, type SupersedeTarget } from '../facts/supersede-resolve.ts';
import { escapeLikePattern } from '../cjk.ts';
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { compileRowNormalizer } from './normalize.ts';

export type EmbeddingCast = '::vector' | '::halfvec';

/**
 * The `facts.embedding` cast suffix. Postgres probes the column (cache state
 * lives on the engine: `PostgresEngine#resolveFactsEmbeddingCast`); PGLite
 * keeps master's constant `::vector`.
 */
export type ResolveEmbeddingCast = () => Promise<EmbeddingCast>;

async function embeddingCast(exec: SqlExecutor, probe: ResolveEmbeddingCast | undefined): Promise<EmbeddingCast> {
  if (!exec.capabilities.probesEmbeddingCast || !probe) return '::vector';
  return probe();
}

/**
 * SQL-side substring filter (before limit) — a client-side post-limit grep
 * silently misses matches outside the newest-N window on high-cardinality
 * entities. Parity with the pglite engine's `_listFacts`.
 */
function grepPattern(opts: FactListOpts | undefined): string | null {
  return (opts?.grep && opts.grep.trim()) ? '%' + escapeLikePattern(opts.grep.trim()) + '%' : null;
}

export async function insertFact(
  exec: SqlExecutor,
  resolveCast: ResolveEmbeddingCast | undefined,
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
    const embedLit = embedding ? toPgVectorLiteral(embedding) : null;
    // v0.41.15.0 (T6, codex #20): match cast to actual column type so
    // a halfvec(N) column doesn't pay an implicit-cast round-trip + can
    // run on pgvector versions that lack the auto vector→halfvec cast.
    const castSuffix = await embeddingCast(exec, resolveCast);
    // v0.35.4 (D-CDX-5) — typed-claim columns. All four nullable.
    const claimMetric = input.claim_metric ?? null;
    const claimValue  = input.claim_value  ?? null;
    const claimUnit   = input.claim_unit   ?? null;
    const claimPeriod = input.claim_period ?? null;

    if (ctx.supersedeId !== undefined) {
      // Per-entity advisory lock + atomic insert + supersede in one txn.
      const supersedeId = ctx.supersedeId;
      const newId = await exec.transaction(async (tx) => {
        if (entitySlug && tx.capabilities.transactionAdvisoryLocks) {
          // Lock-census (PR6 D5): COMPLIANT — key is already source-scoped (source_id || ':' || entity_slug).
          (await tx.run(sqlFragment`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.source_id} || ':' || ${entitySlug}, 0))`)).rows;
        }
        const ins = (await tx.run<{ id: number }>(sqlFragment`
          INSERT INTO facts (
            source_id, entity_slug, fact, kind, visibility, notability, context,
            valid_from, valid_until, source, source_session, confidence,
            embedding, embedded_at, embedding_model, embedded_text_hash,
            claim_metric, claim_value, claim_unit, claim_period
          ) VALUES (
            ${ctx.source_id}, ${entitySlug}, ${input.fact}, ${kind}, ${visibility}, ${notability}, ${context},
            ${validFrom}, ${validUntil}, ${input.source}, ${sourceSession}, ${confidence},
            ${embedLit === null ? null : trustedSql(vectorLiteralSql(embedLit, castSuffix))}, ${embeddedAt}, ${embedding ? input.embedding_model ?? null : null}, ${embedding && input.embedding_model ? sqlFragment`md5(${input.fact})` : null},
            ${claimMetric}, ${claimValue}, ${claimUnit}, ${claimPeriod}
          ) RETURNING id
        `)).rows;
        const id = Number(ins[0].id);
        (await tx.run(sqlFragment`UPDATE facts SET expired_at = now(), superseded_by = ${id}
                 WHERE id = ${supersedeId} AND expired_at IS NULL`)).rows;
        return id;
      });
      return { id: newId, status: 'superseded' };
    }

    // Plain insert path with optional advisory lock for the dedup window
    // (Postgres only: PGLite inserts directly, as it did on master).
    const insertPlain = async (tx: SqlExecutor): Promise<number> => {
      if (entitySlug && tx.capabilities.transactionAdvisoryLocks) {
        // Lock-census (PR6 D5): COMPLIANT — key is already source-scoped (source_id || ':' || entity_slug).
        (await tx.run(sqlFragment`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.source_id} || ':' || ${entitySlug}, 0))`)).rows;
      }
      const ins = (await tx.run<{ id: number }>(sqlFragment`
        INSERT INTO facts (
          source_id, entity_slug, fact, kind, visibility, notability, context,
          valid_from, valid_until, source, source_session, confidence,
          embedding, embedded_at, embedding_model, embedded_text_hash,
          claim_metric, claim_value, claim_unit, claim_period
        ) VALUES (
          ${ctx.source_id}, ${entitySlug}, ${input.fact}, ${kind}, ${visibility}, ${notability}, ${context},
          ${validFrom}, ${validUntil}, ${input.source}, ${sourceSession}, ${confidence},
          ${embedLit === null ? null : trustedSql(vectorLiteralSql(embedLit, castSuffix))}, ${embeddedAt}, ${embedding ? input.embedding_model ?? null : null}, ${embedding && input.embedding_model ? sqlFragment`md5(${input.fact})` : null},
          ${claimMetric}, ${claimValue}, ${claimUnit}, ${claimPeriod}
        ) RETURNING id
      `)).rows;
      return Number(ins[0].id);
    };
    const id = exec.capabilities.transactionAdvisoryLocks
      ? await exec.transaction(insertPlain)
      : await insertPlain(exec);
    return { id, status: 'inserted' };
  }

export async function expireFact(exec: SqlExecutor, id: number, opts?: { supersededBy?: number; at?: Date }): Promise<boolean> {
    const at = opts?.at ?? new Date();
    const supersededBy = opts?.supersededBy ?? null;
    const result = await exec.run(sqlFragment`
      UPDATE facts SET expired_at = ${at}, superseded_by = COALESCE(${supersededBy}, superseded_by)
      WHERE id = ${id} AND expired_at IS NULL
    `);
    return result.affectedRows > 0;
  }

export async function insertFacts(
  exec: SqlExecutor,
  resolveCast: ResolveEmbeddingCast | undefined,
    rows: Array<NewFact & { row_num: number; source_markdown_slug: string; superseded_by_row?: number }>,
    ctx: { source_id: string },
    opts?: { deleteForPageFirst?: { slug: string; excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean } },
  ): Promise<{ inserted: number; ids: number[]; warnings: string[]; deleted: number }> {
    if (rows.length === 0) return { inserted: 0, ids: [], warnings: [], deleted: 0 };

    // v0.41.15.0 (T6, codex #20): resolve the embedding-cast suffix
    // ONCE per process so the cast matches the actual column type
    // (halfvec vs vector). The probe is cached after first call.
    const castSuffix = await embeddingCast(exec, resolveCast);
    const warnings: string[] = [];
    // v0.46 (#3014): captured inside the transaction below when
    // deleteForPageFirst runs; stays 0 for the standalone insert path.
    let deleted = 0;
    // Single transaction so the v51 partial UNIQUE index can roll back
    // the whole batch on constraint violation. Per-row INSERTs (not
    // multi-row VALUES) keep the embedding-vs-no-embedding branching
    // readable; batch sizes are small (5-30 rows per page in practice).
    // v0.46 (#3014): the fence path carries struck rows — `expired_at` is
    // stamped inline here, and `superseded by #N` references are resolved
    // to `facts.superseded_by` in a second pass below (same transaction).
    const ids = await exec.transaction(async (tx) => {
      // v0.46 (#3014) — atomic reconcile: wipe the page's fence-owned rows
      // as the FIRST statement of this transaction so a failing insert
      // below rolls the delete back too. Inlined (not a deleteFactsForPage
      // call) so it shares this transaction — deleteFactsForPage runs on
      // the pool (the root executor), a separate self-committing transaction,
      // which is exactly the split this fix removes. Scoping mirrors it
      // exactly (#1928 excludeSourcePrefixes + #2646 preserveExpiredLegacy).
      const del = opts?.deleteForPageFirst;
      if (del) {
        const expiredLegacyFilter = del.preserveExpiredLegacy
          ? sqlFragment`AND NOT (row_num IS NULL AND expired_at IS NOT NULL)`
          : sqlFragment``;
        const prefixes = del.excludeSourcePrefixes;
        if (prefixes && prefixes.length > 0) {
          const patterns = prefixes.map(p => `${p}%`);
          const r = await tx.run(sqlFragment`
            DELETE FROM facts
            WHERE source_id = ${ctx.source_id}
              AND source_markdown_slug = ${del.slug}
              AND NOT (COALESCE(source, '') LIKE ANY(${patterns}))
              ${expiredLegacyFilter}
          `);
          deleted = r.affectedRows;
        } else {
          const r = await tx.run(sqlFragment`
            DELETE FROM facts
            WHERE source_id = ${ctx.source_id} AND source_markdown_slug = ${del.slug} ${expiredLegacyFilter}
          `);
          deleted = r.affectedRows;
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
        const embedLit = embedding ? toPgVectorLiteral(embedding) : null;
        // v0.35.4 (D-CDX-5) — typed-claim columns. All four nullable.
        const claimMetric = input.claim_metric ?? null;
        const claimValue  = input.claim_value  ?? null;
        const claimUnit   = input.claim_unit   ?? null;
        const claimPeriod = input.claim_period ?? null;
        // v0.40.2.0 — event_type column (Commit 1 migration v89).
        const eventType   = input.event_type   ?? null;

        const ins = (await tx.run<{ id: number }>(sqlFragment`
          INSERT INTO facts (
            source_id, entity_slug, fact, kind, visibility, notability, context,
            valid_from, valid_until, expired_at, source, source_session, confidence,
            embedding, embedded_at, embedding_model, embedded_text_hash,
            row_num, source_markdown_slug,
            claim_metric, claim_value, claim_unit, claim_period,
            event_type
          ) VALUES (
            ${ctx.source_id}, ${entitySlug}, ${input.fact}, ${kind}, ${visibility}, ${notability}, ${context},
            ${validFrom}, ${validUntil}, ${expiredAt}, ${input.source}, ${sourceSession}, ${confidence},
            ${embedLit === null ? null : trustedSql(vectorLiteralSql(embedLit, castSuffix))}, ${embeddedAt}, ${embedding ? input.embedding_model ?? null : null}, ${embedding && input.embedding_model ? sqlFragment`md5(${input.fact})` : null},
            ${input.row_num}, ${input.source_markdown_slug},
            ${claimMetric}, ${claimValue}, ${claimUnit}, ${claimPeriod},
            ${eventType}
          )
          ON CONFLICT (source_id, source_markdown_slug, row_num)
          WHERE row_num IS NOT NULL
          DO NOTHING
          RETURNING id
        `)).rows;
        if (ins[0]) out.push(Number(ins[0].id));
        rowIds.push(ins[0] ? Number(ins[0].id) : null);
      }

      // v0.46 (#3014) — second pass: resolve `superseded by #N` page-local
      // references to fact ids. Same transaction so a target row inserted
      // above is visible. Keyed on (source_id, source_markdown_slug,
      // row_num) — the v51 unique index — so a reference also resolves
      // against a target that already existed before this batch. A target
      // whose `expired_at` is set resolves only when it is itself superseded
      // (an A -> B -> C chain), declared in this batch or already linked in
      // the DB.
      for (let i = 0; i < rows.length; i++) {
        const targetRow = rows[i].superseded_by_row;
        if (targetRow === undefined || rowIds[i] === null) continue;
        const slug = rows[i].source_markdown_slug;
        const chain = supersessionChainOf(rows, slug);
        // Only look up an int4-safe target. An absurd `#N` (11+ digits)
        // would overflow the `row_num` comparison and abort the cycle;
        // skipping the lookup leaves `target` undefined, so
        // resolveSupersededByRow treats it as a dangling reference (NULL +
        // warning) instead of throwing.
        let target: SupersedeTarget | undefined;
        if (isInt4RowRef(targetRow)) {
          const found = (await tx.run<{ id: number; expired_at: Date | null; next_row: number | null }>(sqlFragment`
            SELECT f.id, f.expired_at, n.row_num AS next_row FROM facts f
            LEFT JOIN facts n ON n.id = f.superseded_by
            WHERE f.source_id = ${ctx.source_id}
              AND f.source_markdown_slug = ${slug}
              AND f.row_num = ${targetRow}
            LIMIT 1
          `)).rows;
          target = found[0]
            ? { id: Number(found[0].id), struck: found[0].expired_at != null }
            : undefined;
          if (found[0]?.next_row != null && !chain.has(targetRow)) chain.set(targetRow, Number(found[0].next_row));
        }
        const { superseded_by, warning } = resolveSupersededByRow(rows[i].row_num, targetRow, target, slug, chain);
        if (warning) warnings.push(warning);
        if (superseded_by !== null) {
          (await tx.run(sqlFragment`UPDATE facts SET superseded_by = ${superseded_by} WHERE id = ${rowIds[i]}`)).rows;
        }
      }
      return out;
    });
    return { inserted: ids.length, ids, warnings, deleted };
  }

export async function deleteFactsForPage(
  exec: SqlExecutor,
    slug: string,
    source_id: string,
    opts?: { excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean },
  ): Promise<{ deleted: number }> {
    const prefixes = opts?.excludeSourcePrefixes;
    // #2646: keep soft-expired legacy rows (row_num NULL — never
    // fence-owned) so a fence reconcile can't destroy forget_fact's
    // legacy DB-only forget record.
    const expiredLegacyFilter = opts?.preserveExpiredLegacy
      ? sqlFragment`AND NOT (row_num IS NULL AND expired_at IS NOT NULL)`
      : sqlFragment``;
    if (prefixes && prefixes.length > 0) {
      // #1928: keep rows whose `source` matches an excluded prefix (e.g.
      // `cli:` conversation facts). COALESCE so NULL/empty-source fence rows
      // stay deletable — only the explicitly-protected prefixes survive.
      const patterns = prefixes.map(p => `${p}%`);
      const result = await exec.run(sqlFragment`
        DELETE FROM facts
        WHERE source_id = ${source_id}
          AND source_markdown_slug = ${slug}
          AND NOT (COALESCE(source, '') LIKE ANY(${patterns}))
          ${expiredLegacyFilter}
      `);
      return { deleted: result.affectedRows };
    }
    const result = await exec.run(sqlFragment`
      DELETE FROM facts WHERE source_id = ${source_id} AND source_markdown_slug = ${slug} ${expiredLegacyFilter}
    `);
    return { deleted: result.affectedRows };
  }

export async function listFactsByEntity(
  exec: LegacyUnscopedRead,
    source_id: string,
    entitySlug: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    const limit = clampSearchLimit(opts?.limit, 50, MAX_SEARCH_LIMIT);
    const offset = Math.max(0, opts?.offset ?? 0);
    const activeOnly = opts?.activeOnly !== false;
    const unconsolidatedOnly = opts?.unconsolidatedOnly === true;
    const kinds = (opts?.kinds && opts.kinds.length > 0) ? opts.kinds : null;
    const visibility = (opts?.visibility && opts.visibility.length > 0) ? opts.visibility : null;
    const excludeAuditRows = opts?.excludeAuditRows === true;
    const grepPat = grepPattern(opts);
    // WP5 TTL honesty: activeOnly reads exclude validity-lapsed rows
    // (valid_until <= now()) at read time — exact-time, zero-maintenance.
    // History readers pass activeOnly:false and stay unfiltered. Parity with
    // the pglite engine's _listFacts predicate.
    const rows = (await exec.run<FactRowSqlShape>(sqlFragment`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND entity_slug = ${entitySlug}
        ${activeOnly ? sqlFragment`AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())` : sqlFragment``}
        ${unconsolidatedOnly ? sqlFragment`AND consolidated_at IS NULL` : sqlFragment``}
        ${kinds ? sqlFragment`AND kind = ANY(${kinds}::text[])` : sqlFragment``}
        ${visibility ? sqlFragment`AND visibility = ANY(${visibility}::text[])` : sqlFragment``}
        ${excludeAuditRows ? sqlFragment`AND source != ALL(${AUDIT_ROW_SOURCES}::text[])` : sqlFragment``}
        ${grepPat ? sqlFragment`AND fact ILIKE ${grepPat} ESCAPE '\\'` : sqlFragment``}
      ORDER BY valid_from DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `)).rows;
    return rows.map(rowToFact);
  }

export async function listFactsSince(
  exec: LegacyUnscopedRead,
    source_id: string,
    since: Date,
    opts?: FactListOpts & { entitySlug?: string; sessionId?: string },
  ): Promise<FactRow[]> {
    const limit = clampSearchLimit(opts?.limit, 50, MAX_SEARCH_LIMIT);
    const offset = Math.max(0, opts?.offset ?? 0);
    const activeOnly = opts?.activeOnly !== false;
    const unconsolidatedOnly = opts?.unconsolidatedOnly === true;
    const kinds = (opts?.kinds && opts.kinds.length > 0) ? opts.kinds : null;
    const visibility = (opts?.visibility && opts.visibility.length > 0) ? opts.visibility : null;
    const entitySlug = opts?.entitySlug ?? null;
    const sessionId = opts?.sessionId ?? null;
    const eventTime = opts?.eventTime === true;
    const excludeAuditRows = opts?.excludeAuditRows === true;
    const grepPat = grepPattern(opts);
    const rows = (await exec.run<FactRowSqlShape>(sqlFragment`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND ${eventTime ? sqlFragment`COALESCE(valid_from, created_at)` : sqlFragment`created_at`} >= ${since}
        ${entitySlug ? sqlFragment`AND entity_slug = ${entitySlug}` : sqlFragment``}
        ${sessionId ? sqlFragment`AND source_session = ${sessionId}` : sqlFragment``}
        ${activeOnly ? sqlFragment`AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())` : sqlFragment``}
        ${unconsolidatedOnly ? sqlFragment`AND consolidated_at IS NULL` : sqlFragment``}
        ${kinds ? sqlFragment`AND kind = ANY(${kinds}::text[])` : sqlFragment``}
        ${visibility ? sqlFragment`AND visibility = ANY(${visibility}::text[])` : sqlFragment``}
        ${excludeAuditRows ? sqlFragment`AND source != ALL(${AUDIT_ROW_SOURCES}::text[])` : sqlFragment``}
        ${grepPat ? sqlFragment`AND fact ILIKE ${grepPat} ESCAPE '\\'` : sqlFragment``}
      ORDER BY ${eventTime ? sqlFragment`COALESCE(valid_from, created_at)` : sqlFragment`created_at`} DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `)).rows;
    return rows.map(rowToFact);
  }

export async function listFactsBySession(
  exec: LegacyUnscopedRead,
    source_id: string,
    sessionId: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    const limit = clampSearchLimit(opts?.limit, 50, MAX_SEARCH_LIMIT);
    const offset = Math.max(0, opts?.offset ?? 0);
    const activeOnly = opts?.activeOnly !== false;
    const unconsolidatedOnly = opts?.unconsolidatedOnly === true;
    const kinds = (opts?.kinds && opts.kinds.length > 0) ? opts.kinds : null;
    const visibility = (opts?.visibility && opts.visibility.length > 0) ? opts.visibility : null;
    const excludeAuditRows = opts?.excludeAuditRows === true;
    const grepPat = grepPattern(opts);
    const rows = (await exec.run<FactRowSqlShape>(sqlFragment`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND source_session = ${sessionId}
        ${activeOnly ? sqlFragment`AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())` : sqlFragment``}
        ${unconsolidatedOnly ? sqlFragment`AND consolidated_at IS NULL` : sqlFragment``}
        ${kinds ? sqlFragment`AND kind = ANY(${kinds}::text[])` : sqlFragment``}
        ${visibility ? sqlFragment`AND visibility = ANY(${visibility}::text[])` : sqlFragment``}
        ${excludeAuditRows ? sqlFragment`AND source != ALL(${AUDIT_ROW_SOURCES}::text[])` : sqlFragment``}
        ${grepPat ? sqlFragment`AND fact ILIKE ${grepPat} ESCAPE '\\'` : sqlFragment``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `)).rows;
    return rows.map(rowToFact);
  }

export async function listSupersessions(
  exec: LegacyUnscopedRead,
    source_id: string,
    opts?: { since?: Date; limit?: number; visibility?: ('private' | 'world')[] },
  ): Promise<FactRow[]> {
    const limit = clampSearchLimit(opts?.limit, 50, MAX_SEARCH_LIMIT);
    const since = opts?.since ?? null;
    const visibility = (opts?.visibility && opts.visibility.length > 0) ? opts.visibility : null;
    // v0.46 (#3014) — filter on `superseded_by` alone; the ontology
    // writer closes a superseded row via `valid_until` (not `expired_at`,
    // which would break its `--asof` time-travel), so requiring both
    // columns dropped every ontology supersession AND every fence-authored
    // one. Order / `since` fall back to `valid_until` when `expired_at` is
    // NULL.
    const rows = (await exec.run<FactRowSqlShape>(sqlFragment`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND superseded_by IS NOT NULL
        ${since ? sqlFragment`AND COALESCE(expired_at, valid_until) >= ${since}` : sqlFragment``}
        ${visibility ? sqlFragment`AND visibility = ANY(${visibility}::text[])` : sqlFragment``}
      ORDER BY COALESCE(expired_at, valid_until) DESC, id DESC
      LIMIT ${limit}
    `)).rows;
    return rows.map(rowToFact);
  }

export async function countUnconsolidatedFacts(exec: LegacyUnscopedRead, source_id: string): Promise<number> {
    // Audit checkpoint rows never set consolidated_at, so without the source
    // exclusion each one counts as forever-pending consolidation backlog.
    // Validity-lapsed rows are excluded too: the consolidator reads via
    // listFactsByEntity(activeOnly), which filters them at read time — counting
    // them here would report a backlog the consolidator can never drain.
    const rows = (await exec.run<{ count: number }>(sqlFragment`
      SELECT COUNT(*)::int AS count FROM facts
      WHERE source_id = ${source_id}
        AND consolidated_at IS NULL
        AND expired_at IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND source != ALL(${AUDIT_ROW_SOURCES}::text[])
    `)).rows;
    return Number(rows[0]?.count ?? 0);
  }

export async function findCandidateDuplicates(
  exec: LegacyUnscopedRead,
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array; embeddingModel?: string | null },
  ): Promise<FactRow[]> {
    const k = Math.min(Math.max(opts?.k ?? 5, 1), 20);
    // Validity-lapsed rows are not dedup candidates: a re-stated fact after
    // its valid_until lapses re-inserts fresh (WP5 read-time TTL honesty).
    if (opts?.embedding) {
      if (!opts.embeddingModel) return [];
      const lit = toPgVectorLiteral(opts.embedding);
      const rows = (await exec.run<FactRowSqlShape>(sqlFragment`
        SELECT * FROM facts
        WHERE source_id = ${source_id}
          AND entity_slug = ${entitySlug}
          AND expired_at IS NULL
          AND (valid_until IS NULL OR valid_until > now())
          AND embedding IS NOT NULL
          AND embedding_model=${opts.embeddingModel} AND embedded_text_hash=md5(fact)
          AND vector_dims(embedding)=${opts.embedding.length}
          AND source != ALL(${AUDIT_ROW_SOURCES}::text[])
        ORDER BY embedding <=> ${trustedSql(vectorLiteralSql(lit, '::vector'))}
        LIMIT ${k}
      `)).rows;
      return rows.map(rowToFact);
    }
    const rows = (await exec.run<FactRowSqlShape>(sqlFragment`
      SELECT * FROM facts
      WHERE source_id = ${source_id}
        AND entity_slug = ${entitySlug}
        AND expired_at IS NULL
        AND (valid_until IS NULL OR valid_until > now())
      ORDER BY created_at DESC, id DESC
      LIMIT ${k}
    `)).rows;
    return rows.map(rowToFact);
  }

export async function consolidateFact(exec: SqlExecutor, id: number, takeId: number): Promise<void> {
    (await exec.run(sqlFragment`UPDATE facts SET consolidated_at = now(), consolidated_into = ${takeId} WHERE id = ${id}`)).rows;
  }

export async function findTrajectory(exec: LegacyUnscopedRead, opts: import('../engine.ts').TrajectoryOpts): Promise<import('../engine.ts').TrajectoryPoint[]> {
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

    // Source-scope predicate: array path (federated) wins over scalar.
    // Engine.ts contract: returns chronological points (the NEWEST `limit`,
    // so a capped series keeps its latest value); regressions + drift_score
    // are computed by the caller (src/core/trajectory.ts).
    // v0.40.2.0 — kind filter ('all'|'metric'|'event'); event_type column.
    const rows = (await exec.run<{
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
    }>(sqlFragment`
      SELECT id, valid_from,
             claim_metric, claim_value, claim_unit, claim_period,
             event_type,
             fact, source_session, source_markdown_slug,
             CASE WHEN embedding_model=(SELECT value FROM config WHERE key='embedding_model')
               AND embedded_text_hash=md5(fact) THEN embedding::text END AS embedding
      FROM facts
      WHERE ${useArray ? sqlFragment`source_id = ANY(${sourceIds}::text[])` : sqlFragment`source_id = ${sourceId}`}
        AND entity_slug = ${opts.entitySlug}
        AND expired_at IS NULL
        ${remoteFilter ? sqlFragment`AND visibility = 'world'` : sqlFragment``}
        ${metric !== null ? sqlFragment`AND claim_metric = ${metric}` : sqlFragment``}
        ${kind === 'metric' ? sqlFragment`AND claim_metric IS NOT NULL` : sqlFragment``}
        ${kind === 'event' ? sqlFragment`AND event_type IS NOT NULL` : sqlFragment``}
        ${sinceDate ? sqlFragment`AND valid_from >= ${sinceDate}` : sqlFragment``}
        ${untilDate ? sqlFragment`AND valid_from <= ${untilDate}` : sqlFragment``}
      ORDER BY valid_from DESC, id DESC
      LIMIT ${limit}
    `)).rows;

    return [...rows].reverse().map(r => ({
      fact_id: Number(r.id),
      valid_from: r.valid_from instanceof Date ? r.valid_from : new Date(r.valid_from as unknown as string),
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

export async function getFactsHealth(exec: LegacyUnscopedRead, source_id: string): Promise<FactsHealth> {
    // WP5 TTL honesty: validity-lapsed rows (valid_until <= now(), expired_at
    // NULL) count as expired-style, never active — matches the read-time
    // filtering on every active recall path. active + expired still
    // partitions the table exactly.
    const totals = (await exec.run<{
      total_active: bigint; total_today: bigint; total_week: bigint;
      total_expired: bigint; total_consolidated: bigint;
    }>(sqlFragment`
      SELECT
        COUNT(*) FILTER (WHERE expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()))                                     AS total_active,
        COUNT(*) FILTER (WHERE expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) AND created_at > now() - interval '24 hours') AS total_today,
        COUNT(*) FILTER (WHERE expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) AND created_at > now() - interval '7 days')   AS total_week,
        COUNT(*) FILTER (WHERE expired_at IS NOT NULL OR (valid_until IS NOT NULL AND valid_until <= now()))                            AS total_expired,
        COUNT(*) FILTER (WHERE consolidated_at IS NOT NULL)                            AS total_consolidated
      FROM facts WHERE source_id = ${source_id}
    `)).rows;
    const top = (await exec.run<{ entity_slug: string; count: bigint }>(sqlFragment`
      SELECT entity_slug, COUNT(*) AS count
      FROM facts
      WHERE source_id = ${source_id} AND expired_at IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND entity_slug IS NOT NULL
      GROUP BY entity_slug
      ORDER BY count DESC, entity_slug ASC
      LIMIT 5
    `)).rows;
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
  embedding_model?: string | null;
  embedded_text_hash?: string | null;
  embedded_at: Date | null;
  created_at: Date;
}

/**
 * PGLite can hand timestamp columns back as strings on some paths; the
 * declared kinds make both drivers return `Date` (identity on Postgres).
 */
const normalizeFactRow = compileRowNormalizer<FactRowSqlShape>({
  valid_from: 'date', valid_until: 'date', expired_at: 'date',
  consolidated_at: 'date', embedded_at: 'date', created_at: 'date',
});

function rowToFact(raw: FactRowSqlShape): FactRow {
  const row = normalizeFactRow(raw as unknown as Record<string, unknown>);
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
    embedding_model: row.embedding_model ?? null,
    embedded_text_hash: row.embedded_text_hash ?? null,
    embedded_at: row.embedded_at,
    created_at: row.created_at,
  };
}

/**
 * The inlined vector literal master used (`'[0.1,...]'::vector`): kept as
 * literal text, not a bound param, so the planner sees a constant (HNSW
 * ordering). Registered in scripts/check-engine-sql-dynamic.ts VETTED_BUILDERS:
 * `literal` is always toPgVectorLiteral output (numbers joined by commas) and
 * `cast` one of two constants.
 */
function vectorLiteralSql(literal: string, cast: EmbeddingCast): string {
  return `'${literal}'${cast}`;
}

function toPgVectorLiteral(v: Float32Array | number[]): string {
  if (v instanceof Float32Array) return '[' + Array.from(v).join(',') + ']';
  return '[' + v.join(',') + ']';
}
